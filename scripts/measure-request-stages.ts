/**
 * Measures where wall-clock time actually goes in one /api/chat request.
 *
 *   npx tsx scripts/measure-request-stages.ts
 *
 * Reproduces the route's pipeline stage by stage against the real services,
 * because the route logs only a total and "it feels slow" is not a number.
 * The Voyage queue is reported separately from the Voyage API call itself:
 * they are different costs with different fixes, and conflating them is how
 * a rate-limit problem gets misread as a slow embedding model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getSupabaseServiceClient } from "../lib/supabase";
import { embed } from "../lib/voyage";
import { classifyDistress } from "../lib/distress";

process.loadEnvFile(".env.local");
process.loadEnvFile(".env.development.local");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_WORKSPACE_ID
    ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } }
    : {}),
});
const supabase = getSupabaseServiceClient();

const voyageRatelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(3, "60 s"),
  prefix: "voyage",
});

const MESSAGE = "What is the difference between a focus group and an in-depth interview?";
const SECTION = "17e156cb-2d71-440a-849c-3cf0adac77db";
const EMAIL = "goalkeeper.dielmann@gmail.com";

const rows: [string, number][] = [];
async function stage<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const out = await fn();
  rows.push([label, Date.now() - t]);
  return out;
}

async function main() {
  const limit = await stage("Voyage slot check (Upstash round trip)", () => voyageRatelimit.limit("global"));

  await stage("can_access_section (Supabase RPC)", () =>
    supabase.rpc("can_access_section", { p_student_email: EMAIL, p_section_id: SECTION }),
  );

  const section = await stage("section + course lookup", () =>
    supabase.from("sections").select("course_id, institutional_crisis_resource, courses(program)").eq("id", SECTION).single(),
  );
  const courseId = (section.data as { course_id: string }).course_id;

  const embedding = await stage("Voyage embed: raw API call, no queue", async () =>
    (await embed([MESSAGE], "query"))[0],
  );

  const matched = await stage("match_knowledge_chunks (pgvector)", () =>
    supabase.rpc("match_knowledge_chunks", {
      query_embedding: embedding,
      match_course_id: courseId,
      match_count: 5,
    }),
  );
  const chunks = (matched.data ?? []) as { content: string }[];

  await stage("classifyDistress (Claude; CONCURRENT in route)", () =>
    classifyDistress(anthropic, [], MESSAGE),
  );

  const material = chunks.map((c) => c.content).join("\n\n---\n\n");
  const gen = await stage("main generation (Claude Sonnet 5)", () =>
    anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: `You are a teaching assistant for a marketing research course. Answer only from this material:\n\n${material}`,
      messages: [{ role: "user", content: MESSAGE }],
    }),
  );

  console.log("\nSTAGE                                             ms");
  console.log("------------------------------------------------------");
  for (const [label, ms] of rows) console.log(label.padEnd(46) + String(ms).padStart(7));
  console.log("------------------------------------------------------");
  const serial = rows.filter(([l]) => !l.includes("CONCURRENT")).reduce((a, [, ms]) => a + ms, 0);
  console.log("SERIAL PATH TOTAL (concurrent stage excluded)".padEnd(46) + String(serial).padStart(7));

  console.log(
    `\nslot free: ${limit.success}   remaining in window: ${limit.remaining}   window resets in: ${Math.max(limit.reset - Date.now(), 0)} ms`,
  );
  console.log(`chunks: ${chunks.length}   output tokens: ${gen.usage.output_tokens}`);
}
main();
