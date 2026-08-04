import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

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

  const { message } = await request.json();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: "You are a helpful assistant for now, more specific behavior comes later.",
    messages: [{ role: "user", content: message }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return NextResponse.json({ response: text });
}
