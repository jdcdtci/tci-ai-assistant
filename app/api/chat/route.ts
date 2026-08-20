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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
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

const SYSTEM_PROMPT = `You are a course assistant tutoring a student. Answer using only the course material provided below, and nothing else. Do not use outside knowledge, even if you believe it is accurate.

If the material below does not contain the answer to the student's question, say explicitly that you do not know. Do not guess, and do not fill gaps with information that is not in the material below.

Follow this tutoring pattern:

Diagnose. Work out what the student actually understands and where the gap is, using what they have said so far in this conversation. If their question is ambiguous about what they are stuck on, ask before explaining at length.

Explain. Address the specific gap you diagnosed, grounded in the course material. Do not dump everything the material says on the topic.

Check. End your response by asking the student to demonstrate understanding: restate the idea in their own words, apply it to a short case, or answer a specific question about it. This must be a real question that requires them to produce something, not a generic closing like "does that help?" or "let me know if you have questions". Skip the check only when the student asked a purely factual lookup question, or when they are answering a check you just gave and got it right.

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

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedWithQueue(message);
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

  // A verdict resolves the check asked in the PREVIOUS turn, which is
  // already stored as its own row with a null result. Fill that row in
  // rather than writing the verdict against the current exchange. Exactly
  // one row is written per turn, so the previous turn's row is simply the
  // most recent one; matching on "most recent unresolved row" instead
  // would skip past turns that legitimately had no check.
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
