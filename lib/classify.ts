import Anthropic from "@anthropic-ai/sdk";

export type Turn = { role: "user" | "assistant"; content: string };

// Documented decision (2026-08-20): a pass/fail verdict is warranted whenever
// the student's response gives clear evidence of understanding or
// misunderstanding, whether prompted by an explicit check or volunteered on
// their own; "none" is reserved for genuinely no evidence either way.
// Declining, ignoring, or moving on from an offered follow-up check is a
// complete resolution with no evidence, not a failure and not a check left
// hanging: the row simply keeps its null verdict permanently.
export type ExchangeClassification = {
  concept: string;
  current_response_has_check: boolean;
  // What the check in the CURRENT response is about. Often the same as
  // `concept`, but not always: a turn can explain one idea and then check
  // a different one. The row's verdict will judge the check, so the row
  // must be labelled with this, not with `concept`.
  check_concept: string | null;
  // Verdict on the student's understanding of the PREVIOUS assistant turn's
  // content, judged from their latest message. Evidence-based per the rule
  // above: an explicit check being answered and a volunteered correct (or
  // incorrect) restatement both count. "none" means no clear evidence.
  prior_check_verdict: "passed" | "failed" | "none";
  // What concept that evidence was about. Used to correct the stored concept
  // at verdict time so concept and verdict always describe the same moment.
  prior_check_concept: string | null;
  rationale: string;
};

const CLASSIFIER_TOOL: Anthropic.Tool = {
  name: "record_exchange",
  description: "Record the classification of a tutoring exchange.",
  input_schema: {
    type: "object",
    properties: {
      concept: {
        type: "string",
        description:
          "The single concept or topic this exchange is primarily about, as a short noun phrase (e.g. 'problem definition', 'sampling frame error'). Lowercase unless a proper noun.",
      },
      current_response_has_check: {
        type: "boolean",
        description:
          "True only if the assistant's latest response contains a genuine comprehension check: it asks the student to restate, apply, or confirm understanding. A response that only explains, or that ends with a generic offer like 'let me know if you have questions', is NOT a check.",
      },
      check_concept: {
        type: ["string", "null"],
        description:
          "If current_response_has_check is true, the concept that CHECK specifically asks the student to demonstrate, as a short noun phrase. This is often different from 'concept': a response may explain one idea and then check a different one. Describe what the student must demonstrate to pass the check, not what the response mostly explained. Null if there is no check.",
      },
      prior_check_verdict: {
        type: "string",
        enum: ["passed", "failed", "none"],
        description:
          "Judge whether the student's latest message gives clear evidence of understanding or misunderstanding of what the previous assistant turn covered. 'passed' if they demonstrated correct understanding, either by answering an explicit check correctly or by volunteering a correct restatement or application on their own. 'failed' if their message reveals wrong or confused understanding, prompted or volunteered. 'none' only when there is genuinely no evidence either way, e.g. they asked an unrelated question, changed the subject, or deflected a pending check without attempting it.",
      },
      prior_check_concept: {
        type: ["string", "null"],
        description:
          "If prior_check_verdict is 'passed' or 'failed', the concept the student's evidence was about, as a short noun phrase. For an answered explicit check, judge this from the check question itself, not from where the conversation has moved since. For volunteered evidence, name the concept the student restated or applied. Null if prior_check_verdict is 'none'.",
      },
      rationale: {
        type: "string",
        description:
          "One short sentence explaining these classifications, especially why the check verdict was chosen. Used for debugging.",
      },
    },
    required: [
      "concept",
      "current_response_has_check",
      "check_concept",
      "prior_check_verdict",
      "prior_check_concept",
      "rationale",
    ],
  },
};

const CLASSIFIER_SYSTEM = `You classify tutoring exchanges between a course assistant and a student. You are an observer, not a participant. Do not answer the student's question. Call the record_exchange tool exactly once.

Be strict about what counts as a comprehension check. Asking the student to restate an idea in their own words, apply it to a case, or answer a question about it is a check. Merely explaining, or closing with a generic pleasantry like "does that help?" or "let me know if you want more detail", is not a check.

The prior verdict is about evidence of understanding, not just formal checks. Report passed or failed whenever the student's latest message gives clear evidence of understanding or misunderstanding of what the previous assistant turn covered: answering an explicit check counts, and so does a voluntary restatement, summary, or application the student produced on their own initiative. Report none only when there is genuinely no evidence either way, such as an unrelated question, a topic change, or deflecting a pending check without attempting it. When the evidence is ambiguous, report none rather than guessing.

Declining is not failing. When the previous assistant turn offered a follow-up check as an optional invitation and the student declines it, ignores it, or moves to something else, that is a complete resolution with no evidence either way: report none. Never report failed merely because the student chose not to engage with a check.

Concepts attached to checks matter. A row recording a check's result must name what that check asked the student to demonstrate, judged at the moment the check was posed, not the topic the conversation has drifted to since. A turn often explains one idea and then checks a different, more advanced one; label the check by what it actually tests.`;

function renderTranscript(history: Turn[], latestUser: string, assistantResponse: string): string {
  const lines = history.map((t) => `${t.role === "user" ? "STUDENT" : "ASSISTANT"}: ${t.content}`);
  lines.push(`STUDENT: ${latestUser}`);
  lines.push(`ASSISTANT (latest response, the one being classified): ${assistantResponse}`);
  return lines.join("\n\n");
}

export async function classifyExchange(
  anthropic: Anthropic,
  history: Turn[],
  latestUser: string,
  assistantResponse: string,
): Promise<ExchangeClassification | null> {
  const result = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 512,
    system: CLASSIFIER_SYSTEM,
    tools: [CLASSIFIER_TOOL],
    tool_choice: { type: "tool", name: "record_exchange" },
    messages: [
      {
        role: "user",
        content: `Classify the latest exchange in this tutoring conversation.\n\n${renderTranscript(history, latestUser, assistantResponse)}`,
      },
    ],
  });

  const toolUse = result.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;

  return toolUse.input as ExchangeClassification;
}
