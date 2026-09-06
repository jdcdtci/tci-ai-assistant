import { NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { embed } from "@/lib/voyage";
import { getSupabaseServiceClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { type Turn } from "@/lib/classify";
import { recordExchange, recordMemoryWriteFailure } from "@/lib/memory";
import { buildVoiceSection } from "@/lib/persona";
import { classifyDistress, LOGGABLE_LEVELS, type DistressClassification } from "@/lib/distress";
import {
  fixedDistressResponse,
  hasCrisisAlreadyBeenRaised,
  assemblePersonalDistressResponse,
  PERSONAL_DISTRESS_FALLBACK,
  PERSONAL_DISTRESS_REFLECTION_SYSTEM,
} from "@/lib/distress-response";

// Vercel's default function duration (10s) isn't enough headroom for a
// request that has to queue for Voyage capacity -- a 3-per-60s sliding
// window can force a wait close to a full 60s if the 3 slots were just
// consumed. 300s is accepted without a platform warning on this project
// (modern Vercel plans, Hobby included, support up to 300s under Fluid
// Compute); VOYAGE_MAX_WAIT_MS below stays well under it so there's still
// room for the Supabase lookup and Claude's completion afterward.
export const maxDuration = 300;

// Personal and service-account API keys can be scoped to a single
// workspace (no header needed) or left multi-workspace, which requires
// sending anthropic-workspace-id on every request. Support both without
// requiring a specific key type: send the header only when configured.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
    ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
    : undefined,
});

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
});

// Separate from the per-student `ratelimit` above: Voyage's free-tier cap
// (3 requests/minute) is a single account-wide budget, not per caller, so
// this uses one fixed key ("global") instead of the requester's IP. Backed
// by the same Redis instance so the limit is enforced correctly across
// concurrent serverless instances, not just within one warm process.
const voyageRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1 m"),
  prefix: "ratelimit:voyage",
});

// A 3-per-60s sliding window can force a wait close to a full 60s in the
// worst case, and concurrent waiters that all wake at the same computed
// reset time can collide -- only one wins the freed slot, the other has to
// wait for a second cycle. Budget for a couple of unlucky cycles, with
// room left under maxDuration for the Supabase lookup and Claude's
// completion afterward.
const VOYAGE_MAX_WAIT_MS = 180_000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for a free slot in the shared Voyage rate limit before embedding,
// instead of failing immediately. Under no contention, voyageRatelimit.limit()
// succeeds on the first check and this adds no meaningful delay.
async function embedWithQueue(message: string): Promise<number[]> {
  const deadline = Date.now() + VOYAGE_MAX_WAIT_MS;

  while (true) {
    const { success, reset } = await voyageRatelimit.limit("global");

    if (success) {
      try {
        const [embedding] = await embed([message], "query");
        return embedding;
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        // Voyage's own limiter can still 429 near a sliding-window boundary
        // even after ours said go; fall through and wait for another slot
        // rather than failing the student's request outright.
        if (!errMessage.includes("Voyage AI request failed (429)")) {
          throw err;
        }
      }
    }

    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for embedding capacity.");
    }

    // Jitter avoids multiple concurrent waiters all retrying at the exact
    // same computed reset instant and repeatedly colliding over one slot.
    const jitterMs = Math.floor(Math.random() * 2_000);
    const waitMs = success ? 5_000 + jitterMs : Math.max(reset - Date.now(), 1_000) + jitterMs;
    await sleep(Math.min(waitMs, deadline - Date.now()));
  }
}

const MATCH_COUNT = 5;

// Caps how much conversation is replayed to the model and the classifier.
const MAX_HISTORY_TURNS = 20;

// How much recent conversation feeds the retrieval query. Kept small: the
// goal is topical continuity ("what are we discussing"), not replaying the
// whole conversation into the embedding.
const RETRIEVAL_CONTEXT_TURNS = 4;
const RETRIEVAL_CONTEXT_CHARS_PER_TURN = 300;

function buildRecentContext(priorTurns: Turn[]): string {
  return priorTurns
    .slice(-RETRIEVAL_CONTEXT_TURNS)
    .map((t) => t.content.slice(0, RETRIEVAL_CONTEXT_CHARS_PER_TURN))
    .join("\n");
}

// A genuine follow-up's literal wording often embeds far from the topic
// under discussion (e.g. a student answering a check about pricing embeds
// near pricing material, not the concept being taught), which is why
// recent context gets folded into the retrieval query below. But blindly
// including it is wrong the moment the student has changed topics: a short
// off-topic detour (e.g. an unrelated question, then back to the original
// thread) can dominate the embedding and drag retrieval away from a new,
// on-topic question entirely -- confirmed live, not hypothetical (see
// SESSION_NOTES.md). isFollowUpOnTopic decides which case this is before
// any context is included, rather than including it and hoping the new
// message's wording is strong enough to compete.
function buildRetrievalQuery(recentContext: string, message: string): string {
  if (!recentContext) return message;
  return `${recentContext}\n${message}`;
}

const RELEVANCE_TOOL: Anthropic.Tool = {
  name: "record_relevance",
  description: "Record whether the student's new message continues the topic of the recent conversation.",
  input_schema: {
    type: "object",
    properties: {
      is_follow_up: {
        type: "boolean",
        description:
          "True if the new message continues, elaborates on, or asks about the same topic as the recent conversation below. False if it introduces a new, unrelated topic or question -- including a message that returns to an earlier topic after an intervening unrelated detour; judge only against the recent conversation shown, not the whole session.",
      },
    },
    required: ["is_follow_up"],
  },
};

// Deliberately a fast Claude call rather than a second Voyage embedding:
// Voyage's account-wide rate limit (see embedWithQueue above) is the
// scarce, actively-queued resource in this app; Claude has no equivalent
// constraint here. Only called when there is history -- buildRetrievalQuery
// already skips context entirely on a first message, so there is nothing
// to judge relevance against yet.
async function isFollowUpOnTopic(priorTurns: Turn[], message: string): Promise<boolean> {
  const recent = priorTurns
    .slice(-RETRIEVAL_CONTEXT_TURNS)
    .map((t) => `${t.role === "user" ? "STUDENT" : "ASSISTANT"}: ${t.content}`)
    .join("\n\n");

  const result = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 128,
    system:
      "You determine whether a student's new message continues the topic of a recent conversation, or introduces something unrelated. Call record_relevance exactly once.",
    tools: [RELEVANCE_TOOL],
    tool_choice: { type: "tool", name: "record_relevance" },
    messages: [
      {
        role: "user",
        content: `Recent conversation:\n\n${recent}\n\nStudent's new message: ${message}`,
      },
    ],
  });

  const toolUse = result.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return true;

  return (toolUse.input as { is_follow_up: boolean }).is_follow_up;
}

const SYSTEM_PROMPT = `You are a course assistant tutoring a student. Answer using only the course material provided below, and nothing else. Do not use outside knowledge, even if you believe it is accurate.

If the material below does not contain the answer to the student's question, say explicitly that you do not know. Do not guess, and do not fill gaps with information that is not in the material below.

The course material below is retrieved fresh for each message, so it reflects the wording of the latest exchange and may not include passages that grounded your earlier responses in this conversation. Because of that, never treat the absence of something from the material below as evidence that an earlier response of yours was wrong. Never contradict, retract, or cast doubt on something you already told the student in this conversation unless the material below directly conflicts with it, in which case say so explicitly and correct it. If the student asks a follow-up on a topic you already explained and the material below adds nothing new, keep building on what you already established; if you genuinely cannot go deeper, say plainly that the material you have does not add more detail beyond what you have covered, rather than implying the earlier explanation was ungrounded.

You have no authority over any part of this course beyond explaining its material. Never suggest you can grant an extension, waive a requirement, override a policy, or speak for the instructor's judgment on a grade or an accommodation. In particular, never characterize how easy, hard, or fair an upcoming graded assessment will be, and never reassure a student about how a quiz, exam, or assignment is likely to go for them. You do not know how it was written, how it is graded, or how the instructor calibrated it, so any such comment is a claim you cannot support and may be flatly wrong in a way that costs the student's trust. If a student asks, say plainly that you cannot speak to that, and offer to work through the relevant material with them or point them to their instructor. Being warm is right; implying authority you do not have is not, and the two must never blur together.

Follow this tutoring pattern:

Acknowledge. Only when the student's message signals frustration or repeated effort, for example saying they have read the material several times, that they still don't get it after trying, or similar signs of genuine struggle: open with one short, honest sentence that reflects the specific thing they said, before any explanation. Do not use generic empty reassurance like "great question", "don't worry", or "this is easy", and do not claim the material is simple. Vary the wording naturally from response to response; never fall into a stock opener. When there is no such signal, skip this entirely and begin with the substance.

Diagnose. Work out what the student actually understands and where the gap is, using what they have said so far in this conversation. If their question is ambiguous about what they are stuck on, ask before explaining at length.

Explain. Address the specific gap you diagnosed, grounded in the course material. Do not dump everything the material says on the topic.

Check. End your response by asking the student to demonstrate understanding: restate the idea in their own words, apply it to a short case, or answer a specific question about it. This must be a real question that requires them to produce something, not a generic closing like "does that help?" or "let me know if you have questions". Skip the check when the student asked a purely factual lookup question.

When the student has just answered your previous check correctly, do not pose another check as if it were simply expected. First close the loop in a sentence: say plainly what they just got right and that they have it solid. If a related concept is a natural next step, you may then offer it as an explicit invitation the student is free to decline, for example asking whether they want to go one level further into the related distinction. If their next message declines the invitation, ignores it, or changes topic, treat that as a complete and healthy end of that thread; do not re-pose the invitation or chase it in later turns.

Adapt. If the student's answer to a check was wrong or confused, do not simply repeat the same explanation. Approach the idea differently, and target the specific misunderstanding their answer revealed.

Formatting rules: never use em dashes anywhere in your response. Never use bold text. Write in plain prose only.`;

// Writes the distress event and decides, at write time, whether it crossed a
// notification threshold. Computed here rather than by each reader so the
// review tool and any future delivery channel agree by construction instead
// of reimplementing the same rule twice.
//
// Awaited rather than deferred to after(): this is the record that a human
// follow-up depends on, and it costs one fast insert on a rare turn. It must
// never throw its way into the student's response, though, so failures are
// logged and swallowed. A student in distress receiving an error because the
// logging failed would be the worst possible ordering of priorities.
const PATTERN_LEVELS = ["possible_risk", "crisis"];
const PATTERN_COUNT = 3;
const PATTERN_WINDOW_DAYS = 7;

// True when a classification must be answered with its designated response
// regardless of session or entitlement. Defined once, here, so the override
// boundary exists in exactly one place rather than being re-derived at each
// call site and drifting.
//
// THE BOUNDARY, AND WHY IT SITS EXACTLY HERE
//
// These responses are safe to serve to an unentitled or signed-out caller
// because none of them depends on retrieval or exposes course content:
// crisis and possible_risk are fixed strings, and personal_distress is a
// reflection of the student's own words generated with no course material
// supplied. That is the same reasoning that already makes access_mode
// 'public' safe with no session.
//
// 'none' and 'academic_frustration' are deliberately NOT here. If they were,
// any caller could reach ordinary course content by phrasing a message to
// look like distress, which would trade one real vulnerability for a worse
// one. Anything not in this list takes the normal entitlement path.
export function requiresDistressResponse(c: DistressClassification): boolean {
  return c.interpersonal_harm || LOGGABLE_LEVELS.includes(c.level);
}

async function recordDistressEvent(
  supabase: ReturnType<typeof getSupabaseServiceClient>,
  args: {
    // Null when the caller supplied a course_id that did not resolve to a
    // real course. The event is still recorded: losing a crisis disclosure
    // because the caller sent a bad course id would be the worst possible
    // reason to lose a safety record.
    course_id: string | null;
    student_id: string | null;
    message: string;
    classification: DistressClassification;
  },
) {
  const { course_id, student_id, message, classification } = args;

  let notification_worthy = false;
  let notification_reason: string | null = null;

  try {
    if (classification.interpersonal_harm) {
      // Bypasses the pattern requirement entirely: the obligation to know
      // about a disclosure of interpersonal harm arises on the first
      // occurrence, not the third.
      notification_worthy = true;
      notification_reason = "interpersonal_harm";
    } else if (student_id && course_id && PATTERN_LEVELS.includes(classification.level)) {
      // Pattern needs identity. Anonymous sessions cannot be linked across
      // events, so for them this can never fire and the in-conversation
      // response is the entire intervention.
      const since = new Date(Date.now() - PATTERN_WINDOW_DAYS * 86_400_000).toISOString();
      const { count } = await supabase
        .from("distress_events")
        .select("id", { count: "exact", head: true })
        .eq("student_id", student_id)
        .eq("course_id", course_id)
        .in("level", PATTERN_LEVELS)
        .gte("created_at", since);

      if ((count ?? 0) >= PATTERN_COUNT - 1) {
        notification_worthy = true;
        notification_reason = "pattern";
      }
    }

    const { error } = await supabase.from("distress_events").insert({
      course_id,
      student_id,
      level: classification.level,
      message,
      interpersonal_harm: classification.interpersonal_harm,
      notification_worthy,
      notification_reason,
    });

    if (error) throw new Error(error.message);

    console.log(
      `[distress] logged level=${classification.level} harm=${classification.interpersonal_harm} notify=${notification_reason ?? "no"}`,
    );
  } catch (err) {
    console.error(
      `[distress] FAILED TO LOG a ${classification.level} event: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// The voice section is appended after the engine rules above, never woven
// into them: persona is cosmetic (spec 2.3), and keeping it in its own
// clearly bounded block is what makes that separation auditable in the
// assembled prompt rather than only in the source files.
function buildSystemPrompt(chunks: { content: string }[], program: unknown): string {
  const material = chunks.map((c) => c.content).join("\n\n---\n\n");
  const voice = buildVoiceSection(program);
  const voiceSection = voice ? `\n\n${voice}` : "";
  return `${SYSTEM_PROMPT}${voiceSection}\n\nCourse material:\n\n${material}`;
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anonymous";
  const { success, limit, remaining, reset } = await ratelimit.limit(ip);

  if (!success) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded. Limit is ${limit} requests per minute. Try again after ${new Date(reset).toISOString()}.`,
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": String(remaining),
          "X-RateLimit-Reset": String(reset),
        },
      },
    );
  }

  const { message, course_id, history } = await request.json();

  if (!message || !course_id) {
    return NextResponse.json({ error: "Both 'message' and 'course_id' are required." }, { status: 400 });
  }

  // Identity comes from the verified session, never from the request body,
  // mirroring /api/enroll. `student_id` is deliberately NOT read from the
  // payload any more: a client-supplied id let a caller write history and
  // distress events under someone else's identity, and a client-supplied
  // course_id let any caller read any course's content, which was
  // demonstrated live against a purpose-built second course.
  const supabaseAuth = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  const verifiedEmail = user?.email ?? null;
  const student_id = user?.id ?? null;

  // Entitlement is decided by the database, not here. can_access_course
  // fails closed on every path that is not an explicit allow: unknown
  // course, expired course, access_mode 'closed', no session where a session
  // is required, and no matching enrollments row. It is called BEFORE the
  // embedding and retrieval so an unentitled request never reaches
  // match_knowledge_chunks and never spends a Voyage slot.
  const supabase = getSupabaseServiceClient();
  const { data: allowed, error: accessError } = await supabase.rpc("can_access_course", {
    p_student_email: verifiedEmail,
    p_course_id: course_id,
  });

  if (accessError) {
    // Fail closed on an error too. An access check that cannot run is not
    // an access check that passed.
    console.error(`[access] can_access_course failed for course ${course_id}: ${accessError.message}`);
    return NextResponse.json({ error: "Could not verify course access right now." }, { status: 503 });
  }

  const priorTurns: Turn[] = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : [];

  if (allowed !== true) {
    // NOT entitled. Before refusing, classify: a distress signal must be
    // answered regardless of session or entitlement, because a person in
    // crisis is a person in crisis whether or not their enrollment is in
    // order, their session has expired, or they named the wrong course.
    //
    // Classification runs here rather than before the entitlement check so
    // an entitled student's ordinary question keeps the existing parallel
    // flow and pays no added latency. The cost of this branch is one
    // classifier call for an unentitled caller, bounded by the per-IP rate
    // limit already applied at the top of this handler.
    const refusedDistress = await classifyDistress(anthropic, priorTurns, message);

    if (refusedDistress && requiresDistressResponse(refusedDistress)) {
      // The caller-supplied course_id is still untrusted here. Resolve it
      // against real courses; attach it only if it exists, otherwise record
      // the event with no course association rather than trusting an
      // unvalidated value or dropping a safety record.
      const { data: realCourse } = await supabase
        .from("courses")
        .select("id")
        .eq("id", course_id)
        .maybeSingle();

      await recordDistressEvent(supabase, {
        course_id: realCourse?.id ?? null,
        student_id,
        message,
        classification: refusedDistress,
      });

      console.warn(
        `[access] refused course=${course_id} session=${verifiedEmail ? "yes" : "none"} but served distress response level=${refusedDistress.level} harm=${refusedDistress.interpersonal_harm} course_attached=${realCourse ? "yes" : "no"}`,
      );

      const fixedForRefused = fixedDistressResponse(refusedDistress.level, {
        crisisAlreadyRaised: hasCrisisAlreadyBeenRaised(priorTurns),
        // Deliberately omitted. institutional_crisis_resource is the one
        // course-derived value in a distress response, and this caller has
        // not been shown to be entitled to this course. The 988 baseline is
        // complete and safe on its own, which is exactly why it is the
        // baseline. Serving it alone keeps the override from becoming a way
        // to read a course row.
        institutionalResource: undefined,
      });

      if (fixedForRefused) {
        return NextResponse.json({ response: fixedForRefused });
      }

      // personal_distress: a reflection of the caller's own words plus fixed
      // text. No course material is supplied, so nothing course-scoped can
      // leak through it.
      try {
        const reflectionReply = await anthropic.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 120,
          system: PERSONAL_DISTRESS_REFLECTION_SYSTEM,
          messages: [...priorTurns, { role: "user", content: message }],
        });
        return NextResponse.json({
          response: assemblePersonalDistressResponse(
            reflectionReply.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(""),
          ),
        });
      } catch {
        return NextResponse.json({ response: PERSONAL_DISTRESS_FALLBACK });
      }
    }

    // Not a distress signal: the ordinary entitlement rules apply unchanged.
    // This is the boundary that stops the override from becoming a way to
    // reach course content by phrasing a message as though it were distress.
    console.warn(
      `[access] refused course=${course_id} session=${verifiedEmail ? "yes" : "none"}`,
    );
    return NextResponse.json(
      {
        error: verifiedEmail
          ? "You are not enrolled in this course."
          : "You must be signed in to use this course assistant.",
      },
      { status: verifiedEmail ? 403 : 401 },
    );
  }


  // Started immediately and awaited only once a response is about to be
  // produced, so distress detection costs no added latency on the ordinary
  // path. It genuinely must be able to REPLACE the response, unlike
  // classifyExchange which runs in after() precisely because it cannot
  // affect what the student sees. Retrieval still runs underneath and is
  // simply discarded when distress fires: wasting an embedding on a rare
  // turn is a better trade than adding a serial model call to every turn.
  const distressPromise = classifyDistress(anthropic, priorTurns, message);

  let retrievalQuery = message;
  if (priorTurns.length > 0) {
    let isFollowUp: boolean;
    try {
      isFollowUp = await isFollowUpOnTopic(priorTurns, message);
    } catch (err) {
      // Fail open to the augmented query: if the relevance check itself is
      // unavailable, degrade to pre-fix behavior (always include context)
      // rather than silently dropping context that a genuine follow-up
      // still needs.
      isFollowUp = true;
    }

    if (isFollowUp) {
      retrievalQuery = buildRetrievalQuery(buildRecentContext(priorTurns), message);
    }

    console.log(`[retrieval] follow_up=${isFollowUp} message="${message}"`);
  }

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedWithQueue(retrievalQuery);
  } catch (err) {
    return NextResponse.json(
      { error: "Could not generate an embedding for your message right now. Please try again shortly." },
      { status: 503 },
    );
  }

  // Retrieval and the course lookup are independent, so they run together
  // rather than in sequence. The course row is needed only for its program,
  // which selects the persona voice.
  const [
    { data: chunks, error: retrievalError },
    { data: course, error: courseError },
  ] = await Promise.all([
    supabase.rpc("match_knowledge_chunks", {
      query_embedding: queryEmbedding,
      match_course_id: course_id,
      match_count: MATCH_COUNT,
    }),
    supabase
      .from("courses")
      .select("program, institutional_crisis_resource")
      .eq("id", course_id)
      .maybeSingle(),
  ]);

  // Persona is cosmetic, so a failed or missing course lookup must never
  // cost the student an answer. Fall back to the engine's default voice and
  // log it; buildVoiceSection degrades to no voice section on its own.
  if (courseError || !course) {
    console.warn(`[persona] course lookup failed for ${course_id}; using default voice`);
  }

  // Distress handling is resolved BEFORE the retrieval-failure and
  // empty-material branches below, deliberately. Those branches return
  // "I don't know" or a 500, and a student in crisis whose message happened
  // to retrieve nothing would otherwise receive one of those instead of a
  // crisis response. Distress outranks every retrieval outcome.
  const distress = await distressPromise;

  if (distress && distress.level !== "none" && distress.level !== "academic_frustration") {
    if (LOGGABLE_LEVELS.includes(distress.level)) {
      await recordDistressEvent(supabase, {
        course_id,
        student_id: typeof student_id === "string" ? student_id : null,
        message,
        classification: distress,
      });
    }

    const fixed = fixedDistressResponse(distress.level, {
      crisisAlreadyRaised: hasCrisisAlreadyBeenRaised(priorTurns),
      institutionalResource: course?.institutional_crisis_resource,
    });

    if (fixed) {
      console.log(`[distress] level=${distress.level} responded with fixed text`);
      return NextResponse.json({ response: fixed });
    }

    // personal_distress: only the reflection is generated. Everything after
    // it is fixed text. No course material is supplied, so there is nothing
    // for the model to slide back into tutoring from, and max_tokens bounds
    // the reflection structurally rather than by instruction alone.
    console.log(`[distress] level=${distress.level} responded with reflection plus fixed text`);
    let reflection = "";
    try {
      const reflectionReply = await anthropic.messages.create({
        model: "claude-sonnet-5",
        // THIS BOUND IS THE MECHANISM, not a performance setting. A response
        // that cannot exceed roughly two sentences cannot re-grow the
        // limitation sentence, the instructor routing, and the three-option
        // close that now live in fixed text. The prompt also names and
        // forbids the stock openers, but that is a supporting instruction:
        // two separate instructions against stock openers were already in
        // place before this change and the model produced one in six out of
        // six live samples anyway. If you raise or remove this, do not
        // assume the wording rules will hold on their own. Re-run a batch of
        // personal_distress samples and check the openers first.
        max_tokens: 120,
        system: PERSONAL_DISTRESS_REFLECTION_SYSTEM,
        messages: [...priorTurns, { role: "user", content: message }],
      });
      reflection = reflectionReply.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    } catch (err) {
      // The fixed portion still stands on its own, so a failed reflection
      // costs specificity rather than costing the student a response.
      console.warn(
        `[distress] reflection generation failed, sending fixed portion alone: ${err instanceof Error ? err.message : String(err)}`,
      );
      return NextResponse.json({ response: PERSONAL_DISTRESS_FALLBACK });
    }

    return NextResponse.json({ response: assemblePersonalDistressResponse(reflection) });
  }

  if (retrievalError) {
    return NextResponse.json({ error: "Could not retrieve course material right now." }, { status: 500 });
  }

  if (!chunks || chunks.length === 0) {
    return NextResponse.json({
      response: "I don't know. I don't have any course material available to answer that question.",
    });
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system: buildSystemPrompt(chunks, course?.program),
    messages: [...priorTurns, { role: "user", content: message }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Classification needs a second model call, so run it after the response
  // is already on its way to the student. A failure here must never affect
  // the answer they see.
  if (student_id) {
    after(async () => {
      try {
        await recordExchange({
          anthropic,
          supabase,
          studentId: student_id,
          courseId: course_id,
          priorTurns,
          latestUser: message,
          assistantResponse: text,
        });
      } catch (err) {
        // Backstop only. recordExchange records its own failures durably;
        // this catches anything that escapes it, and records that too rather
        // than leaving a console line as the sole trace inside after().
        await recordMemoryWriteFailure(supabase, {
          studentId: student_id,
          courseId: course_id,
          reason: "exception",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return NextResponse.json({ response: text });
}
