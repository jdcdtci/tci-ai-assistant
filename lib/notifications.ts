import type { getSupabaseServiceClient } from "./supabase";
import { sendEscalationNotice } from "./email";

// The escalation sweep.
//
// Runs on a schedule rather than inside /api/chat, deliberately. The distress
// write path is the most safety-critical code in this system and it gains no
// outbound network dependency and no new failure mode from this work. A send
// that fails simply stays pending: rows are not marked, so the next sweep
// retries by construction.

type Supabase = ReturnType<typeof getSupabaseServiceClient>;

export type NotificationFailureReason =
  | "provider_error"
  | "exception"
  | "not_configured"
  | "insert_failed";

type PendingRow = {
  section_id: string;
  student_id: string;
  student_email: string;
  recipient_email: string;
  event_count: number;
  window_opened_at: string;
  latest_reason: "pattern" | "interpersonal_harm";
};

/**
 * Records that a notification did not go out. Never throws.
 *
 * Same pattern as memory_write_failures and history_write_failures. This one
 * matters most of the three: the others lose a record, this one lets a
 * wellbeing escalation evaporate while the system behaves as though someone
 * was told.
 */
export async function recordNotificationFailure(
  supabase: Supabase,
  args: {
    sectionId: string;
    studentId: string;
    recipientEmail: string | null;
    reason: NotificationFailureReason;
    detail?: string;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from("notification_delivery_failures").insert({
      section_id: args.sectionId,
      student_id: args.studentId,
      recipient_email: args.recipientEmail,
      reason: args.reason,
      // System error text only, never anything the student wrote.
      detail: args.detail?.slice(0, 500) ?? null,
    });
    if (error) throw new Error(error.message);
    console.error(`[notify] recorded delivery failure: ${args.reason}`);
  } catch (err) {
    console.error(
      `[notify] COULD NOT RECORD delivery failure (${args.reason}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * True when a not_configured failure was already recorded recently.
 *
 * Without this the sweep would write one such row every ten minutes forever
 * while the credentials are missing, which buries the real failures it exists
 * to surface. Bounded to roughly four rows a day instead.
 */
async function configurationFailureAlreadyRecorded(supabase: Supabase): Promise<boolean> {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("notification_delivery_failures")
    .select("id", { count: "exact", head: true })
    .eq("reason", "not_configured")
    .gte("created_at", since);
  return (count ?? 0) > 0;
}

export type SweepResult = { pending: number; sent: number; failed: number; skipped: boolean };

export async function runEscalationSweep(supabase: Supabase): Promise<SweepResult> {
  // Who is due. Entitlement-shaped: a section with no ACCEPTED escalation
  // recipient produces no row here, because pending_escalations inner-joins
  // to accepted recipients. There is no fallback address and this code could
  // not introduce one.
  const { data, error } = await supabase.rpc("pending_escalations");

  if (error) {
    console.error(`[notify] could not read pending escalations: ${error.message}`);
    return { pending: 0, sent: 0, failed: 0, skipped: true };
  }

  const pending = (data ?? []) as PendingRow[];
  if (pending.length === 0) {
    return { pending: 0, sent: 0, failed: 0, skipped: false };
  }

  const baseUrl = process.env.NOTIFY_SIGN_IN_URL;
  const configured = Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM_ADDRESS && baseUrl);

  if (!configured) {
    console.error(`[notify] not configured; ${pending.length} notification(s) pending`);
    if (!(await configurationFailureAlreadyRecorded(supabase))) {
      const first = pending[0];
      await recordNotificationFailure(supabase, {
        sectionId: first.section_id,
        studentId: first.student_id,
        recipientEmail: null,
        reason: "not_configured",
        detail: `${pending.length} notification(s) pending; RESEND_API_KEY, NOTIFY_FROM_ADDRESS or NOTIFY_SIGN_IN_URL missing`,
      });
    }
    return { pending: pending.length, sent: 0, failed: 0, skipped: true };
  }

  // Names for the email. Read here rather than returned by
  // pending_escalations, which is about entitlement and counting.
  const sectionIds = [...new Set(pending.map((p) => p.section_id))];
  const { data: sections } = await supabase
    .from("sections")
    .select("id, label, courses(name)")
    .in("id", sectionIds);

  const nameOf = new Map<string, { label: string; courseName: string }>();
  for (const s of (sections ?? []) as unknown as {
    id: string;
    label: string;
    courses: { name: string } | null;
  }[]) {
    nameOf.set(s.id, { label: s.label, courseName: s.courses?.name ?? "" });
  }

  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    const names = nameOf.get(row.section_id) ?? { label: "", courseName: "" };
    try {
      const { providerMessageId } = await sendEscalationNotice({
        recipientEmail: row.recipient_email,
        studentEmail: row.student_email,
        courseName: names.courseName,
        sectionLabel: names.label,
        eventCount: row.event_count,
        windowOpenedAt: new Date(row.window_opened_at),
        reason: row.latest_reason,
        signInUrl: baseUrl!,
      });

      // Recorded only AFTER a successful send. If this insert fails the
      // notification will be sent again on the next sweep, which is the
      // right way round: a duplicate escalation is recoverable, a silently
      // suppressed one is not.
      const { error: insertError } = await supabase.from("notification_deliveries").insert({
        section_id: row.section_id,
        student_id: row.student_id,
        recipient_email: row.recipient_email,
        window_opened_at: row.window_opened_at,
        event_count: row.event_count,
        provider_message_id: providerMessageId,
      });

      if (insertError) {
        failed++;
        await recordNotificationFailure(supabase, {
          sectionId: row.section_id,
          studentId: row.student_id,
          recipientEmail: row.recipient_email,
          reason: "insert_failed",
          detail: insertError.message,
        });
        continue;
      }

      sent++;
      console.log(
        `[notify] sent section=${row.section_id} events=${row.event_count} reason=${row.latest_reason}`,
      );
    } catch (err) {
      failed++;
      const detail = err instanceof Error ? err.message : String(err);
      await recordNotificationFailure(supabase, {
        sectionId: row.section_id,
        studentId: row.student_id,
        recipientEmail: row.recipient_email,
        reason: detail.startsWith("Resend error") ? "provider_error" : "exception",
        detail,
      });
    }
  }

  return { pending: pending.length, sent, failed, skipped: false };
}
