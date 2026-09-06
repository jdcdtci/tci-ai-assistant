/**
 * Forced-failure test for the distress classifier's fail-open path.
 *
 *   npx tsx scripts/test-distress-failure-path.ts
 *
 * WHY THIS EXISTS
 *
 * classifyDistress fails open by design: when it cannot produce an
 * assessment it returns null and the caller proceeds as if no distress was
 * detected. That is the right trade (failing closed would return crisis
 * responses to every student during any outage), but it means a total
 * failure and a genuinely calm student produce the SAME return value. The
 * only thing distinguishing them is that a failure must be loud.
 *
 * The file already claimed to log loudly while its catch block silently
 * discarded the error. That gap was found by accident, when a deprecated
 * `temperature` parameter made every call 400 and the resulting silence
 * looked like rate limiting. A requirement that is only ever verified by
 * the accident that violates it is not verified. This test forces real API
 * failures and asserts the fail-open path is observable.
 *
 * maxRetries is 0 on these clients so the SDK's own internal retries do not
 * mask or inflate the two attempts and single backoff we are measuring.
 */
import Anthropic from "@anthropic-ai/sdk";
import { classifyDistress } from "../lib/distress";

process.loadEnvFile(".env.local");

const BACKOFF_MS = 750;

type Scenario = { name: string; client: Anthropic };

const SCENARIOS: Scenario[] = [
  {
    name: "invalid API key (401)",
    client: new Anthropic({ apiKey: "sk-ant-invalid-key-for-testing", maxRetries: 0 }),
  },
  {
    name: "unreachable API host (network failure)",
    client: new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: "https://127.0.0.1:9",
      maxRetries: 0,
    }),
  },
];

async function run(scenario: Scenario) {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  const started = Date.now();
  let result: unknown;
  try {
    result = await classifyDistress(scenario.client, [], "I do not want to be here anymore.");
  } finally {
    console.warn = originalWarn;
  }
  const elapsed = Date.now() - started;

  const checks: [string, boolean, string][] = [
    ["returns null rather than a fabricated verdict", result === null, `got ${JSON.stringify(result)}`],
    [
      "logged both failed attempts",
      warnings.filter((w) => w.includes("classification attempt")).length === 2,
      `attempt lines: ${warnings.filter((w) => w.includes("classification attempt")).length}`,
    ],
    [
      "logged an explicit give-up line",
      warnings.some((w) => w.includes("classification unavailable")),
      "no 'classification unavailable' line",
    ],
    [
      "surfaced a real cause, not an empty message",
      warnings.some((w) => w.includes("classification attempt") && w.replace(/.*failed:\s*/, "").trim().length > 3),
      "attempt lines carried no cause text",
    ],
    [
      `backed off at least ${BACKOFF_MS}ms before retrying`,
      elapsed >= BACKOFF_MS,
      `elapsed ${elapsed}ms`,
    ],
  ];

  console.log(`\n--- ${scenario.name} (elapsed ${elapsed}ms) ---`);
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  [${detail}]`}`);
  }
  console.log("  logged output:");
  for (const w of warnings) console.log(`    ${w.slice(0, 150)}`);

  return checks.every(([, ok]) => ok);
}

async function main() {
  let allOk = true;
  for (const s of SCENARIOS) {
    const ok = await run(s);
    allOk = allOk && ok;
  }
  console.log(`\n${allOk ? "ALL SCENARIOS PASS" : "FAILURES PRESENT"}`);
  if (!allOk) process.exitCode = 1;
}

main();
