/**
 * Regression test for the evidence-based comprehension-check verdict rule.
 *
 *   npx tsx scripts/test-verdict-rule.ts
 *
 * The documented rule (lib/classify.ts): a verdict is recorded whenever the
 * student's reply gives real evidence of understanding, whether prompted by
 * an explicit check or volunteered on their own. Declining or ignoring an
 * offered check resolves as null (no evidence), not as a failure.
 *
 * This drives lib/memory.ts's recordExchange directly rather than going
 * through /api/chat. The route's session gate is not the mechanism under
 * test, and requiring a real sign-in would make this unrunnable. Everything
 * below the route (classifyExchange, the prior-row resolution, the concept
 * re-stamping) is the real code path.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseServiceClient } from "../lib/supabase";
import { recordExchange } from "../lib/memory";

process.loadEnvFile(".env.local");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_WORKSPACE_ID
    ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } }
    : {}),
});

const COURSE_ID = "cbd8d7e2-b787-446e-9bce-aac386dfaaae";
const STUDENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const EXPLAIN_WITH_CHECK =
  "A sampling frame is the operational list of units you can actually draw from, while the target population is the ideal set you want to describe. Coverage error is the gap between them. To check you have it: in your own words, what is the difference between a sampling frame and a target population?";

type Scenario = {
  name: string;
  studentReply: string;
  assistantReply: string;
  expect: boolean | null;
  why: string;
};

const SCENARIOS: Scenario[] = [
  {
    name: "prompted check answered CORRECTLY",
    studentReply:
      "The target population is everyone I actually want to describe, and the sampling frame is the list I can really reach, so the gap between them is coverage error.",
    assistantReply: "That is exactly right, you have it solid.",
    expect: true,
    why: "explicit check answered correctly -> passed",
  },
  {
    name: "prompted check answered INCORRECTLY",
    studentReply:
      "They are the same thing, the sampling frame is just another name for the population you are studying.",
    assistantReply:
      "Not quite, and the difference matters. Let me come at it from another angle.",
    expect: false,
    why: "explicit check answered wrongly -> failed",
  },
  {
    name: "check DECLINED, topic changed",
    studentReply: "Can we move on to something else, what is conjoint analysis?",
    assistantReply: "Sure. Conjoint analysis measures how people trade off product attributes.",
    expect: null,
    why: "declining is not failing -> stays null",
  },
];

async function seedPriorTurn(supabase: ReturnType<typeof getSupabaseServiceClient>) {
  await recordExchange({
    anthropic,
    supabase,
    studentId: STUDENT_ID,
    courseId: COURSE_ID,
    priorTurns: [],
    latestUser: "What is a sampling frame?",
    assistantResponse: EXPLAIN_WITH_CHECK,
  });
}

async function main() {
  const supabase = getSupabaseServiceClient();
  let allOk = true;

  for (const s of SCENARIOS) {
    await supabase.from("student_interaction_history").delete().eq("student_id", STUDENT_ID);

    // Turn 1: the assistant explains and poses a check. This row is written
    // with a null verdict, waiting to be resolved by the student's reply.
    await seedPriorTurn(supabase);

    const { data: seeded } = await supabase
      .from("student_interaction_history")
      .select("id, concept, comprehension_check_passed")
      .eq("student_id", STUDENT_ID);

    const seededOk = (seeded ?? []).length === 1 && seeded![0].comprehension_check_passed === null;

    // Turn 2: the student replies. This is the exchange under test.
    await recordExchange({
      anthropic,
      supabase,
      studentId: STUDENT_ID,
      courseId: COURSE_ID,
      priorTurns: [
        { role: "user", content: "What is a sampling frame?" },
        { role: "assistant", content: EXPLAIN_WITH_CHECK },
      ],
      latestUser: s.studentReply,
      assistantResponse: s.assistantReply,
    });

    const { data: after } = await supabase
      .from("student_interaction_history")
      .select("id, concept, comprehension_check_passed, created_at")
      .eq("student_id", STUDENT_ID)
      .order("created_at", { ascending: true });

    const rows = after ?? [];
    const resolved = rows.find((r) => r.id === seeded?.[0]?.id);
    const got = resolved?.comprehension_check_passed ?? null;
    const ok = got === s.expect;
    if (!ok || !seededOk) allOk = false;

    console.log(`\n--- ${s.name} ---`);
    console.log(`  ${seededOk ? "PASS" : "FAIL"}  prior turn seeded with a null verdict`);
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  prior row resolved to ${JSON.stringify(got)} (expected ${JSON.stringify(s.expect)}) -- ${s.why}`,
    );
    console.log(`  concept on resolved row: ${JSON.stringify(resolved?.concept)}`);
    console.log(`  rows written for this student: ${rows.length}`);
  }

  await supabase.from("student_interaction_history").delete().eq("student_id", STUDENT_ID);
  const { count } = await supabase
    .from("student_interaction_history")
    .select("id", { count: "exact", head: true })
    .eq("student_id", STUDENT_ID);
  console.log(`\ncleanup: rows remaining for test student = ${count}`);
  console.log(allOk ? "\nALL SCENARIOS PASS" : "\nFAILURES PRESENT");
  if (!allOk) process.exitCode = 1;
}

main();
