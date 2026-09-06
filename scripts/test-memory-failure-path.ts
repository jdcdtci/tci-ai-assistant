/**
 * Forced-failure test for the interaction-history write path.
 *
 *   npx tsx scripts/test-memory-failure-path.ts
 *
 * WHY THIS EXISTS
 *
 * recordExchange runs inside after(). When it declined to write, it said so
 * only via console output, which locally reaches a TTY that survives while a
 * window stays open and on Vercel reaches a log drain nobody reads. This
 * session hit exactly that wall: answering "did the memory write silently
 * skip?" depended on a terminal still being open with enough scrollback.
 *
 * Every failure path now records a durable row in memory_write_failures.
 * This test forces each path for real and asserts the row appears, so the
 * guarantee is verified rather than asserted.
 *
 * The classifier is driven to fail genuinely rather than stubbed out:
 * scenario 1 supplies a client whose response contains no tool_use block,
 * which is precisely the condition classifyExchange returns null on, so the
 * real null branch executes. Scenario 2 supplies a client that throws.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getSupabaseServiceClient } from "../lib/supabase";
import { recordExchange } from "../lib/memory";

process.loadEnvFile(".env.local");

// Resolved at runtime rather than hardcoded: the section id did not exist
// before the sections migration, and hardcoding a uuid would silently rot.
let SECTION_ID = "";
const STUDENT_ID = "88888888-8888-8888-8888-888888888888";

// A client whose completion carries no tool_use block. classifyExchange
// looks for one, does not find it, and returns null: the real path.
const clientWithNoToolUse = {
  messages: {
    create: async () => ({ content: [{ type: "text", text: "no tool call here" }] }),
  },
} as unknown as Anthropic;

const clientThatThrows = {
  messages: {
    create: async () => {
      throw new Error("simulated upstream failure");
    },
  },
} as unknown as Anthropic;

async function main() {
  const supabase = getSupabaseServiceClient();
  const { data: sec } = await supabase.from("sections").select("id").limit(1).maybeSingle();
  if (!sec) throw new Error("No section found. Run the sections migration first.");
  SECTION_ID = sec.id;

  const before = await supabase
    .from("student_interaction_history")
    .select("id", { count: "exact", head: true })
    .eq("student_id", STUDENT_ID);

  const scenarios: { name: string; client: Anthropic; expectReason: string }[] = [
    {
      name: "classifier returns null (no tool_use in response)",
      client: clientWithNoToolUse,
      expectReason: "classifier_returned_null",
    },
    {
      name: "classifier throws",
      client: clientThatThrows,
      expectReason: "exception",
    },
  ];

  let allOk = true;

  for (const s of scenarios) {
    await supabase.from("memory_write_failures").delete().eq("student_id", STUDENT_ID);

    await recordExchange({
      anthropic: s.client,
      supabase,
      studentId: STUDENT_ID,
      sectionId: SECTION_ID,
      priorTurns: [],
      latestUser: "What is a sampling frame?",
      assistantResponse: "A sampling frame is the operational list units are drawn from.",
    });

    const { data: failures } = await supabase
      .from("memory_write_failures")
      .select("reason, detail, student_id, section_id")
      .eq("student_id", STUDENT_ID);

    const { count: historyCount } = await supabase
      .from("student_interaction_history")
      .select("id", { count: "exact", head: true })
      .eq("student_id", STUDENT_ID);

    const rows = failures ?? [];
    const checks: [string, boolean, string][] = [
      ["exactly one failure row recorded", rows.length === 1, `got ${rows.length}`],
      [
        `reason is "${s.expectReason}"`,
        rows[0]?.reason === s.expectReason,
        `got ${rows[0]?.reason}`,
      ],
      ["row carries the student and section", rows[0]?.student_id === STUDENT_ID && rows[0]?.section_id === SECTION_ID, "ids missing"],
      [
        "no history row was written",
        (historyCount ?? 0) === (before.count ?? 0),
        `history count ${historyCount}`,
      ],
    ];

    console.log(`\n--- ${s.name} ---`);
    for (const [label, ok, detail] of checks) {
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  [${detail}]`}`);
      if (!ok) allOk = false;
    }
    if (rows[0]?.detail) console.log(`  detail recorded: ${rows[0].detail}`);
  }

  // Clean up after ourselves, same as every other test in this project.
  await supabase.from("memory_write_failures").delete().eq("student_id", STUDENT_ID);
  const { count: leftover } = await supabase
    .from("memory_write_failures")
    .select("id", { count: "exact", head: true });
  console.log(`\ncleanup: memory_write_failures rows remaining = ${leftover}`);

  console.log(allOk ? "\nALL SCENARIOS PASS" : "\nFAILURES PRESENT");
  if (!allOk) process.exitCode = 1;
}

main();
