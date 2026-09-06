import Anthropic from "@anthropic-ai/sdk";
import { classifyExchange, type Turn } from "./classify";
import type { getSupabaseServiceClient } from "./supabase";

// Interaction-history write path, extracted from the chat route so that its
// failure modes can be driven directly by a test rather than only observed
// in passing.
//
// WHY THIS MODULE EXISTS SEPARATELY
//
// This runs inside after(), which is the easiest place in the stack to lose
// output: locally it reaches a TTY that survives only while a window stays
// open, and on Vercel a log drain nobody reads. A write that silently does
// not happen was therefore, until now, invisible after the fact. Every
// failure path here records a durable row in memory_write_failures instead
// of relying on console output, so "did this silently fail" is a query.

type Supabase = ReturnType<typeof getSupabaseServiceClient>;

export type MemoryFailureReason = "classifier_returned_null" | "exception" | "insert_failed";

/**
 * Records that an interaction-history write did not happen.
 *
 * Never throws. If this insert itself fails there is nowhere left to go, so
 * it falls back to console output as a genuine last resort rather than as
 * the primary mechanism.
 */
export async function recordMemoryWriteFailure(
  supabase: Supabase,
  args: { studentId: string; courseId: string; reason: MemoryFailureReason; detail?: string },
): Promise<void> {
  try {
    const { error } = await supabase.from("memory_write_failures").insert({
      student_id: args.studentId,
      course_id: args.courseId,
      reason: args.reason,
      // System error text only, never anything the student wrote.
      detail: args.detail?.slice(0, 500) ?? null,
    });
    if (error) throw new Error(error.message);
    console.error(`[memory] recorded write failure: ${args.reason}`);
  } catch (err) {
    console.error(
      `[memory] COULD NOT RECORD write failure (${args.reason}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type RecordExchangeArgs = {
  anthropic: Anthropic;
  supabase: ReturnType<typeof getSupabaseServiceClient>;
  studentId: string;
  courseId: string;
  priorTurns: Turn[];
  latestUser: string;
  assistantResponse: string;
};

export async function recordExchange({
  anthropic,
  supabase,
  studentId,
  courseId,
  priorTurns,
  latestUser,
  assistantResponse,
}: RecordExchangeArgs) {
  let classification;
  try {
    classification = await classifyExchange(anthropic, priorTurns, latestUser, assistantResponse);
  } catch (err) {
    // The classifier call itself failed. Previously this propagated to a
    // catch in the route that only logged, so the lost write left no trace.
    await recordMemoryWriteFailure(supabase, {
      studentId,
      courseId,
      reason: "exception",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!classification) {
    // The classifier returned without a tool call. This is the specific path
    // that was silently skipping: it produced a console line inside after()
    // and nothing else, so the write simply never appeared and no record of
    // why survived.
    await recordMemoryWriteFailure(supabase, {
      studentId,
      courseId,
      reason: "classifier_returned_null",
    });
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

  // A verdict resolves the PREVIOUS turn's row, which is stored with a
  // null result. Per the documented rule in lib/classify.ts, a verdict can
  // come from an answered explicit check or from a voluntary demonstration
  // of understanding; either way it judges the previous turn's content.
  // Exactly one row is written per turn, so the previous turn's row is
  // simply the most recent one; matching on "most recent unresolved row"
  // instead would skip past turns that legitimately had no check.
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
    // The classification succeeded but the row did not land. Same invisible
    // outcome as the two paths above, so it gets the same durable record.
    await recordMemoryWriteFailure(supabase, {
      studentId,
      courseId,
      reason: "insert_failed",
      detail: insertError.message,
    });
  }
}
