import { Resend } from "resend";

// Escalation email. The ONLY sender in this project, deliberately.
//
// ============================================================================
// WHY THIS MODULE EXPORTS NO GENERAL-PURPOSE SEND FUNCTION
// ============================================================================
//
// The rule is that no email may ever contain a student's message text. That
// rule is not enforced by the callers remembering it. It is enforced by
// there being no way to express it.
//
// The Resend client below is module-private. Nothing outside this file can
// reach it. The single exported function accepts EscalationNotice, which has
// no `body`, no `text`, no `html`, no `subject`, and no index signature. The
// message is composed HERE, from those fields and nothing else. A caller
// holding a student's distress text has no parameter to put it in.
//
// This is the same discipline already applied to the two notification tables,
// which have no column capable of holding message content, and to
// public.messages, whose CHECK constraints make a redacted row carrying
// content impossible. Structure, not vigilance.
//
// If a future feature genuinely needs to send different mail, it gets its own
// narrowly-typed function beside this one. It does not get a generic sender,
// and this type does not grow a free-text field.

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Everything an escalation email is permitted to say.
 *
 * Identity and context only: who, which section, when, why the threshold
 * crossed, and where to sign in. Every field here is a fact ABOUT an event.
 * None of them is, or can hold, the content OF one.
 */
export type EscalationNotice = {
  /** The accepted escalation recipient for the section. */
  recipientEmail: string;
  /** Who the notification concerns. */
  studentEmail: string;
  courseName: string;
  sectionLabel: string;
  /** How many qualifying events since the last notification. A count only. */
  eventCount: number;
  /** When the span this notification covers began. */
  windowOpenedAt: Date;
  /** Why the threshold was crossed. A closed union, not free text. */
  reason: "pattern" | "interpersonal_harm";
  /** Where to sign in to review. */
  signInUrl: string;
};

const REASON_TEXT: Record<EscalationNotice["reason"], string> = {
  pattern: "three or more wellbeing signals were recorded within seven days",
  interpersonal_harm: "a disclosure involving interpersonal harm was recorded",
};

/**
 * Sends one escalation notice. Throws on provider error; the caller records
 * the failure durably.
 */
export async function sendEscalationNotice(
  notice: EscalationNotice,
): Promise<{ providerMessageId: string | null }> {
  const from = process.env.NOTIFY_FROM_ADDRESS;
  if (!from) throw new Error("NOTIFY_FROM_ADDRESS is not set");

  const when = notice.windowOpenedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";

  // Composed here, from the typed fields above. There is no path by which
  // caller-supplied prose reaches this string.
  const lines = [
    `A wellbeing notification threshold was crossed in ${notice.courseName}, ${notice.sectionLabel}.`,
    ``,
    `Student: ${notice.studentEmail}`,
    `Events since the last notification: ${notice.eventCount}`,
    `Earliest of those: ${when}`,
    `Reason: ${REASON_TEXT[notice.reason]}`,
    ``,
    `This message deliberately does not include anything the student wrote.`,
    `That content is held in the system under its own retention policy and is`,
    `readable only by the named wellbeing reader, after signing in:`,
    ``,
    notice.signInUrl,
    ``,
    `You are receiving this because you are the accepted escalation recipient`,
    `for this section.`,
  ];

  const { data, error } = await resend.emails.send({
    from,
    to: notice.recipientEmail,
    subject: `Wellbeing notification: ${notice.courseName} ${notice.sectionLabel}`,
    text: lines.join("\n"),
  });

  if (error) throw new Error(`Resend error: ${error.message ?? String(error)}`);
  return { providerMessageId: data?.id ?? null };
}
