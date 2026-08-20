import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { embed } from "@/lib/voyage";
import { getSupabaseServiceClient } from "@/lib/supabase";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const ratelimit = new Ratelimit({
  redis: new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  }),
  limiter: Ratelimit.slidingWindow(10, "1 m"),
});

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
    [queryEmbedding] = await embed([message], "query");
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
    max_tokens: 1024,
    system: buildSystemPrompt(chunks),
    messages: [{ role: "user", content: message }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return NextResponse.json({ response: text });
}
