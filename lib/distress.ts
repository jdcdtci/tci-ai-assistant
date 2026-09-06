import Anthropic from "@anthropic-ai/sdk";
import type { Turn } from "./classify";

export type { Turn };

// Distress-signal detection. Spec 9.1 names this the single highest-priority
// open item in the specification, and warns specifically against assuming
// "that the model will simply notice" on the chosen runtime model. So this is
// a dedicated classifier call with a forced tool use, the same shape as
// isFollowUpOnTopic, rather than an instruction added to the tutoring prompt.
//
// It runs for anonymous students too, so nothing here may depend on a
// student_id the way the interaction-history write path does.

export type DistressLevel =
  | "none"
  | "academic_frustration"
  | "personal_distress"
  | "possible_risk"
  | "crisis";

// Only these three are storable in distress_events. 'none' and
// 'academic_frustration' are deliberately not recorded: accumulating rows
// every time a student finds the coursework hard would amount to a
// surveillance record of ordinary struggle, and struggle patterns belong to
// the interaction-history path instead.
export const LOGGABLE_LEVELS: DistressLevel[] = [
  "personal_distress",
  "possible_risk",
  "crisis",
];

export type DistressSubject = "self" | "another_person" | "coursework_or_hypothetical";

export type DistressClassification = {
  level: DistressLevel;
  subject: DistressSubject;
  rationale: string;
};

const DISTRESS_TOOL: Anthropic.Tool = {
  name: "record_distress",
  description: "Record the distress assessment of a student's latest message.",
  input_schema: {
    type: "object",
    properties: {
      level: {
        type: "string",
        enum: ["none", "academic_frustration", "personal_distress", "possible_risk", "crisis"],
        description:
          "The distress level of the student's latest message, per the definitions and the two uncertainty rules in the system prompt.",
      },
      subject: {
        type: "string",
        enum: ["self", "another_person", "coursework_or_hypothetical"],
        description:
          "Who the message is actually about. 'self' when the student speaks about their own situation or state. 'another_person' when they describe a real person they are concerned about. 'coursework_or_hypothetical' when the content is study design, instrument wording, hypothetical research subjects, or academic discussion, including discussion of distressing topics as subject matter.",
      },
      rationale: {
        type: "string",
        description:
          "One short sentence explaining the level chosen, and where relevant which uncertainty rule was applied. Used for debugging and review.",
      },
    },
    required: ["level", "subject", "rationale"],
  },
};

const DISTRESS_SYSTEM = `You assess a single student message for signs of distress, so that a course assistant can respond appropriately. You are an observer, not a participant: never answer the student's question and never address the student. Call the record_distress tool exactly once.

Classify the STUDENT'S LATEST MESSAGE. Earlier turns are context for interpreting it, not the thing being classified.

The levels:

none. No distress signal. Ordinary course questions, including academic discussion of difficult or sensitive subject matter.

academic_frustration. Frustration, discouragement, or stress about the coursework itself: not understanding material after real effort, feeling behind, workload pressure, anxiety about a deadline or a grade. This is ordinary academic struggle and is not a wellbeing concern.

personal_distress. A genuine wellbeing signal about the student's own life or state, with no indication of danger: personal circumstances affecting them, exhaustion, being overwhelmed beyond the coursework, grief, or a topic hitting close to home.

possible_risk. Language that could indicate risk of harm but is genuinely ambiguous: hopelessness, saying nothing matters or there is no point, withdrawal, or statements readable as either weariness or something more serious.

crisis. Explicit or strongly implied risk of harm to self or others, being unsafe, abuse, or a medical emergency. This includes a clear disclosure about another real person the student is worried about.

Two rules about uncertainty, and they point in OPPOSITE directions. Apply the one that belongs to the boundary you are actually on.

Between academic_frustration and personal_distress, when unsure, choose the LOWER level. Treating ordinary coursework frustration as a wellbeing concern is itself harmful: it is condescending to a student who is merely stuck, and it teaches students to ignore the response in the case where it matters.

Between possible_risk and crisis, when unsure, choose the HIGHER level. Here the cost of under-reacting is far greater than the cost of over-reacting.

Apply that rule specifically when the student refers to something serious indirectly rather than naming it. A disclosure does not have to be explicit to be a disclosure. When a student says they have been having "those thoughts", "the same thoughts", or "thoughts like that", and their own sentence or the immediate conversation supplies a referent involving suicide, self-harm, or not wanting to be alive, treat that referent as stated: this is crisis, not possible_risk. The same applies to a student who says they have "felt that way too" or "been there myself" in response to such material. Do not downgrade a disclosure merely because the student reached for a pronoun or a euphemism instead of the words themselves.

This does not mean treating every gloomy or weary statement as crisis. The test is whether a specific serious referent is actually recoverable from what the student wrote or from the immediate conversation. General hopelessness with no such referent stays possible_risk.

Academic discussion of distressing subjects is not distress. This course is marketing research, and it covers survey design, research ethics, vulnerable populations, and sensitive-topic instruments. A student may legitimately discuss studying depression, self-harm, or suicide as research subject matter. That is none.

Critically, a survey item is itself written in the first person. A student who quotes, drafts, critiques, or asks you to write an instrument item such as "I have thought about ending my life" is doing coursework, not disclosing something about themselves. Distinguish a student ASSERTING something about themselves from a student QUOTING or CONSTRUCTING instrument wording. The question is whether the student is speaking in their own voice about their own present situation.

Third person is not automatically safe. The academic exclusion covers hypothetical and study-design discussion. It does not cover a student telling you about a real person they are worried about. "My roommate said she doesn't want to live anymore" is a real disclosure and must be treated as one.

A real disclosure can be embedded inside academic framing. "I'm designing the depression survey and honestly I've been having those thoughts myself" is a first-person disclosure, not coursework, regardless of the academic context surrounding it.`;

function renderContext(history: Turn[], latestUser: string): string {
  const lines = history.map((t) => `${t.role === "user" ? "STUDENT" : "ASSISTANT"}: ${t.content}`);
  lines.push(`STUDENT (latest message, the one being classified): ${latestUser}`);
  return lines.join("\n\n");
}

// How many prior turns to include as interpretive context. Small on purpose:
// enough to disambiguate a short message, not so much that an earlier
// emotional turn colours an unrelated later one.
const DISTRESS_CONTEXT_TURNS = 4;

/**
 * Returns null when the assessment could not be produced.
 *
 * Failure behaviour is deliberately fail-open (the caller proceeds as if no
 * signal was found) after one retry, and this is a real accepted limitation
 * rather than an oversight. Failing closed would mean returning a crisis
 * response to every student during any classifier outage, which is both
 * absurd in the common case and actively destructive of the mechanism: a
 * student who receives crisis resources for asking about conjoint analysis
 * learns to dismiss them. The cost of fail-open is that a genuine distress
 * message arriving during an outage receives an ordinary tutoring response,
 * which is the behaviour the system has today in every case. Callers must log
 * the failure loudly rather than swallowing it.
 */
export async function classifyDistress(
  anthropic: Anthropic,
  history: Turn[],
  latestUser: string,
): Promise<DistressClassification | null> {
  const context = renderContext(history.slice(-DISTRESS_CONTEXT_TURNS), latestUser);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 256,
        // No temperature parameter: it is deprecated for this model and
        // sending it returns a 400. Exact run-to-run determinism is
        // therefore not available here, so a single case changing verdict
        // between test runs needs a confirming re-run before it is read as
        // a real effect of a prompt change rather than sampling variance.
        system: DISTRESS_SYSTEM,
        tools: [DISTRESS_TOOL],
        tool_choice: { type: "tool", name: "record_distress" },
        messages: [{ role: "user", content: context }],
      });

      const toolUse = result.content.find((block) => block.type === "tool_use");
      if (toolUse && toolUse.type === "tool_use") {
        return toolUse.input as DistressClassification;
      }
    } catch (err) {
      // Never swallow the cause. This component fails open by design, so a
      // silent failure is indistinguishable from "no distress detected",
      // which is precisely the state that must never be invisible.
      console.warn(
        `[distress] classification attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Brief backoff before the single retry. An immediate retry against a
      // rate limit just fails again, and this runs inline with a student's
      // request, so the wait stays short.
      if (attempt === 0) await new Promise((r) => setTimeout(r, 750));
    }
  }

  console.warn("[distress] classification unavailable; proceeding without a distress signal");
  return null;
}
