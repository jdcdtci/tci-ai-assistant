import type { getSupabaseServiceClient } from "./supabase";
import { requiresDistressResponse, type DistressClassification } from "./distress";

// Student-facing conversation history: the write half.
//
// Extracted from the chat route for the same reason lib/memory.ts was: its
// failure modes should be drivable by a test rather than only observable in
// passing, and the route is already long enough that a second write path
// buried inside it would be hard to audit.

type Supabase = ReturnType<typeof getSupabaseServiceClient>;

// The single value public.messages.redaction_reason permits. The CHECK
// constraint rejects anything else, so this constant and the database agree
// by construction rather than by convention.
export const REDACTION_REASON = "withheld_by_policy";

// Must match force_placeholder_title_when_first_turn_redacted(). The trigger
// is the enforcement; this is what we write so the trigger normally has
// nothing to correct.
export const PLACEHOLDER_TITLE = "Conversation";

const MAX_TITLE_LENGTH = 80;

export type HistoryFailureReason = "insert_failed" | "exception" | "missing_conversation";

/**
 * Records that a transcript turn was not written.
 *
 * Never throws. A transcript that silently drops a turn is worse than a
 * memory write that drops a concept, because the student can SEE the
 * transcript and will believe it complete.
 */
export async function recordHistoryWriteFailure(
  supabase: Supabase,
  args: {
    studentId: string;
    sectionId: string;
    conversationId: string | null;
    role: "user" | "assistant";
    reason: HistoryFailureReason;
    detail?: string;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from("history_write_failures").insert({
      student_id: args.studentId,
      section_id: args.sectionId,
      conversation_id: args.conversationId,
      role: args.role,
      reason: args.reason,
      // System error text only, never anything the student wrote.
      detail: args.detail?.slice(0, 500) ?? null,
    });
    if (error) throw new Error(error.message);
    console.error(`[history] recorded write failure: ${args.reason} role=${args.role}`);
  } catch (err) {
    console.error(
      `[history] COULD NOT RECORD write failure (${args.reason}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Whether this exchange is withheld from public.messages entirely.
 *
 * Deliberately the same predicate that decides a distress response, imported
 * rather than restated: the turn that gets a distress response is exactly
 * the turn that is not stored. A null classification means the classifier
 * did not run or returned nothing, which is not evidence of safety, so it
 * stores normally only because a non-distress turn is the overwhelming case
 * and the distress path has its own independent record in distress_events.
 */
export function exchangeIsRedacted(c: DistressClassification | null): boolean {
  return c !== null && requiresDistressResponse(c);
}

/**
 * Derives a conversation title from the first STORED user message.
 *
 * Reads from public.messages rather than from the in-flight request, which
 * is what makes the title safe by construction: redacted content is never in
 * that table, so there is nothing distress-related to derive from and the
 * placeholder is the only possible outcome. The database trigger enforces
 * the same thing independently.
 */
export async function deriveTitle(
  supabase: Supabase,
  conversationId: string,
): Promise<string> {
  const { data } = await supabase
    .from("messages")
    .select("content, redacted_at")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const content = data?.content;
  if (!content || typeof content !== "string") return PLACEHOLDER_TITLE;

  const flat = content.replace(/\s+/g, " ").trim();
  if (flat === "") return PLACEHOLDER_TITLE;
  return flat.length <= MAX_TITLE_LENGTH ? flat : `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

/**
 * Writes one exchange: the student's turn and the assistant's reply.
 *
 * When redacted, BOTH rows are markers carrying no content. The rule covers
 * the assistant's side because the fixed crisis text itself reveals that a
 * crisis occurred, so storing only the student's side as a marker would
 * defeat the rule while appearing to honour it.
 *
 * Never throws. Every failure lands in history_write_failures.
 */
export async function recordExchangeTurns(
  supabase: Supabase,
  args: {
    conversationId: string;
    studentId: string;
    sectionId: string;
    userText: string;
    assistantText: string;
    redacted: boolean;
    // When the student's message ARRIVED, not when this write runs.
    //
    // These rows are written after the reply is generated, so a default
    // created_at records generation-completion order rather than the order
    // things happened on screen. A slow reply then lands behind a faster
    // message the student sent later, and the transcript reads out of
    // sequence. Observed live on 2026-09-07: a 77s answer was stored after
    // an exchange sent well after it.
    receivedAt: string;
  },
): Promise<void> {
  const { conversationId, studentId, sectionId, userText, assistantText, redacted, receivedAt } = args;

  const rows = (["user", "assistant"] as const).map((role) => ({
    conversation_id: conversationId,
    role,
    content: redacted ? null : role === "user" ? userText : assistantText,
    redacted_at: redacted ? receivedAt : null,
    redaction_reason: redacted ? REDACTION_REASON : null,
    // Both halves of one exchange share a timestamp on purpose: they are one
    // event. Their relative order is settled by the read query ordering on
    // role, not by inventing a millisecond of separation that did not exist.
    created_at: receivedAt,
  }));

  try {
    const { error } = await supabase.from("messages").insert(rows);
    if (error) {
      // Both rows fail together, so both are recorded. Knowing only that
      // "an exchange" was lost would leave which side ambiguous.
      for (const role of ["user", "assistant"] as const) {
        await recordHistoryWriteFailure(supabase, {
          studentId,
          sectionId,
          conversationId,
          role,
          reason: "insert_failed",
          detail: error.message,
        });
      }
      return;
    }
  } catch (err) {
    for (const role of ["user", "assistant"] as const) {
      await recordHistoryWriteFailure(supabase, {
        studentId,
        sectionId,
        conversationId,
        role,
        reason: "exception",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Title on first exchange, and updated_at on every one, so the sidebar
  // orders by real activity. A failure here costs ordering and a title, not
  // the transcript, so it is logged rather than recorded as a lost turn.
  try {
    const { data: conv } = await supabase
      .from("conversations")
      .select("title")
      .eq("id", conversationId)
      .maybeSingle();

    const patch: Record<string, unknown> = { updated_at: receivedAt };
    if (!conv?.title) patch.title = await deriveTitle(supabase, conversationId);

    await supabase.from("conversations").update(patch).eq("id", conversationId);
  } catch (err) {
    console.error(
      `[history] title/updated_at write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
