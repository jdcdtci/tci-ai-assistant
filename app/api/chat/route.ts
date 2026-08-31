import { NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { embed } from "@/lib/voyage";
import { getSupabaseServiceClient } from "@/lib/supabase";
import { classifyExchange, type Turn } from "@/lib/classify";

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

Follow this tutoring pattern:

Acknowledge. Only when the student's message signals frustration or repeated effort, for example saying they have read the material several times, that they still don't get it after trying, or similar signs of genuine struggle: open with one short, honest sentence that reflects the specific thing they said, before any explanation. Do not use generic empty reassurance like "great question", "don't worry", or "this is easy", and do not claim the material is simple. Vary the wording naturally from response to response; never fall into a stock opener. When there is no such signal, skip this entirely and begin with the substance.

Diagnose. Work out what the student actually understands and where the gap is, using what they have said so far in this conversation. If their question is ambiguous about what they are stuck on, ask before explaining at length.

Explain. Address the specific gap you diagnosed, grounded in the course material. Do not dump everything the material says on the topic.

Check. End your response by asking the student to demonstrate understanding: restate the idea in their own words, apply it to a short case, or answer a specific question about it. This must be a real question that requires them to produce something, not a generic closing like "does that help?" or "let me know if you have questions". Skip the check when the student asked a purely factual lookup question.

When the student has just answered your previous check correctly, do not pose another check as if it were simply expected. First close the loop in a sentence: say plainly what they just got right and that they have it solid. If a related concept is a natural next step, you may then offer it as an explicit invitation the student is free to decline, for example asking whether they want to go one level further into the related distinction. If their next message declines the invitation, ignores it, or changes topic, treat that as a complete and healthy end of that thread; do not re-pose the invitation or chase it in later turns.

Adapt. If the student's answer to a check was wrong or confused, do not simply repeat the same explanation. Approach the idea differently, and target the specific misunderstanding their answer revealed.

Formatting rules: never use em dashes anywhere in your response. Never use bold text. Write in plain prose only.`;

function buildSystemPrompt(chunks: { content: string }[]): string {
  const material = chunks.map((c) => c.content).join("\n\n---\n\n");
  return `${SYSTEM_PROMPT}\n\nCourse material:\n\n${material}`;
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

  const { message, course_id, student_id, history } = await request.json();

  if (!message || !course_id) {
    return NextResponse.json({ error: "Both 'message' and 'course_id' are required." }, { status: 400 });
  }

  const priorTurns: Turn[] = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : [];

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

  const supabase = getSupabaseServiceClient();
  const { data: chunks, error: retrievalError } = await supabase.rpc("match_knowledge_chunks", {
    query_embedding: queryEmbedding,
    match_course_id: course_id,
    match_count: MATCH_COUNT,
  });

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
    system: buildSystemPrompt(chunks),
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
          supabase,
          studentId: student_id,
          courseId: course_id,
          priorTurns,
          latestUser: message,
          assistantResponse: text,
        });
      } catch (err) {
        console.error("[memory] failed to record exchange:", err);
      }
    });
  }

  return NextResponse.json({ response: text });
}

type RecordExchangeArgs = {
  supabase: ReturnType<typeof getSupabaseServiceClient>;
  studentId: string;
  courseId: string;
  priorTurns: Turn[];
  latestUser: string;
  assistantResponse: string;
};

async function recordExchange({
  supabase,
  studentId,
  courseId,
  priorTurns,
  latestUser,
  assistantResponse,
}: RecordExchangeArgs) {
  const classification = await classifyExchange(anthropic, priorTurns, latestUser, assistantResponse);

  if (!classification) {
    console.error("[memory] classifier returned no result; skipping write");
    return;
  }

  const {
    concept,
    current_response_has_check,
    check_concept,
    prior_check_verdict,
    prior_check_concept,
    rationale,
  } = classification;

  // A row that carries a check will later be stamped with that check's
  // verdict, so it must be labelled with what the check tests, not with
  // whatever the turn mostly explained. Otherwise the concept and the
  // verdict end up describing two different moments.
  const rowConcept = (current_response_has_check && check_concept) || concept;

  // The rationale is deliberately logged rather than stored: the table
  // schema stays as specified, but the judgment behind each row is
  // recoverable here if the data ever looks inconsistent.
  console.log(
    `[memory] student=${studentId} concept="${rowConcept}" check_asked=${current_response_has_check} prior_verdict=${prior_check_verdict} :: ${rationale}`,
  );

  // A verdict resolves the PREVIOUS turn's row, which is stored with a
  // null result. Per the documented rule in lib/classify.ts, a verdict can
  // come from an answered explicit check or from a voluntary demonstration
  // of understanding; either way it judges the previous turn's content.
  // Exactly one row is written per turn, so the previous turn's row is
  // simply the most recent one; matching on "most recent unresolved row"
  // instead would skip past turns that legitimately had no check.
  if (prior_check_verdict !== "none") {
    const { data: priorRow, error: lookupError } = await supabase
      .from("student_interaction_history")
      .select("id, concept, comprehension_check_passed")
      .eq("student_id", studentId)
      .eq("course_id", courseId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      console.error("[memory] failed to look up prior row:", lookupError.message);
    } else if (!priorRow) {
      console.warn("[memory] verdict reported but no prior row exists; skipping resolve");
    } else if (priorRow.comprehension_check_passed !== null) {
      console.warn(
        `[memory] verdict reported but most recent row ${priorRow.id} is already resolved; skipping to avoid overwriting`,
      );
    } else {
      // Re-stamp the concept from the check itself. The row was labelled
      // when the check was posed; this corrects it if that label drifted.
      const resolvedConcept = prior_check_concept ?? priorRow.concept;

      const { error: updateError } = await supabase
        .from("student_interaction_history")
        .update({
          comprehension_check_passed: prior_check_verdict === "passed",
          concept: resolvedConcept,
        })
        .eq("id", priorRow.id);

      if (updateError) {
        console.error("[memory] failed to update prior row:", updateError.message);
      } else {
        const corrected = resolvedConcept !== priorRow.concept;
        console.log(
          `[memory] resolved prior check on row ${priorRow.id} as ${prior_check_verdict}, concept="${resolvedConcept}"` +
            (corrected ? ` (corrected from "${priorRow.concept}")` : ""),
        );
      }
    }
  }

  const { error: insertError } = await supabase.from("student_interaction_history").insert({
    student_id: studentId,
    course_id: courseId,
    concept: rowConcept,
    // Stays null until the student's next message lets the check be judged.
    comprehension_check_passed: null,
  });

  if (insertError) {
    console.error("[memory] failed to insert row:", insertError.message);
  }
}
