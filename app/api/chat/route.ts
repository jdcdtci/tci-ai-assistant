import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { embed } from "@/lib/voyage";
import { getSupabaseServiceClient } from "@/lib/supabase";

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

const SYSTEM_PROMPT = `You are a course assistant. Answer the student's question using only the course material provided below, and nothing else. Do not use outside knowledge, even if you believe it is accurate.

If the material below does not contain the answer to the student's question, say explicitly that you do not know. Do not guess, and do not fill gaps with information that is not in the material below.

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

  const { message, course_id } = await request.json();

  if (!message || !course_id) {
    return NextResponse.json({ error: "Both 'message' and 'course_id' are required." }, { status: 400 });
  }

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
    messages: [{ role: "user", content: message }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return NextResponse.json({ response: text });
}
