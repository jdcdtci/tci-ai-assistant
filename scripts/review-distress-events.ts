/**
 * Distress log review, for the committed reader.
 *
 *   npm run distress-log
 *   npm run distress-log -- --since 7
 *   npm run distress-log -- --level crisis
 *   npm run distress-log -- --course MKTG365 --since 1
 *
 * WHY THIS IS A LOCAL SCRIPT AND NOT A WEB PAGE
 *
 * The brief was admin-only, no new authentication system, and no
 * professor-facing exposure. A web route would have to be gated by
 * something, and the only gate that exists today is the shared whole-site
 * SITE_PASSWORD. That password has to be handed to the instructor the
 * moment they are onboarded to see their own course, which would silently
 * grant them access to every student's crisis disclosure at the same time.
 * Coupling those two things together is exactly the kind of accidental
 * privilege this project keeps trying to design out.
 *
 * A local script has no web surface at all and is gated by possession of
 * SUPABASE_SECRET_KEY, which only the operator has. That is genuinely
 * admin-only without inventing an auth system, and it cannot be reached by
 * anyone who merely knows a URL.
 *
 * This is the operational half of the commitment recorded in
 * courses.distress_log_reader_email / distress_log_review_interval_hours:
 * the field records who promised to look and how often, and this is the
 * thing they actually run.
 *
 * NOTE: output contains students' own words about being in distress. It is
 * FERPA-relevant on a for-credit course. Do not paste it into a shared
 * channel, a ticket, or a chat transcript.
 */
import { getSupabaseServiceClient } from "../lib/supabase";

process.loadEnvFile(".env.local");

// Matches the pattern threshold in the stage 2 response design: three
// events at possible_risk or higher, same identified student, same course,
// inside seven days. Recorded there as an unvalidated starting point.
const PATTERN_LEVELS = ["possible_risk", "crisis"];
const PATTERN_COUNT = 3;
const PATTERN_WINDOW_DAYS = 7;

type Row = {
  id: string;
  section_id: string | null;
  student_id: string | null;
  level: string;
  message: string | null;
  message_purged_at: string | null;
  interpersonal_harm: boolean;
  created_at: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fmt(ts: string): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

async function main() {
  const sinceDays = Number(arg("since") ?? 30);
  const levelFilter = arg("level");
  const courseName = arg("course");
  const limit = Number(arg("limit") ?? 200);

  const supabase = getSupabaseServiceClient();

  // Sections now carry access and staffing; the wellbeing reader is a role
  // row in section_staff rather than a column, so the commitment is a real
  // assignment rather than a string that happened to be right.
  const { data: sections, error: sectionErr } = await supabase
    .from("sections")
    .select("id, label, courses(name)");
  if (sectionErr) throw new Error(`Could not load sections: ${sectionErr.message}`);

  const nameById = new Map<string, string>(
    (sections ?? []).map((s) => [
      s.id,
      `${(s.courses as unknown as { name: string } | null)?.name ?? "?"} / ${s.label}`,
    ]),
  );
  const targetSection = courseName
    ? (sections ?? []).find((s) =>
        ((s.courses as unknown as { name: string } | null)?.name ?? "").toLowerCase() ===
        courseName.toLowerCase(),
      )
    : undefined;
  if (courseName && !targetSection) throw new Error(`No section for course ${courseName}`);

  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  let query = supabase
    .from("distress_events")
    .select(
      "id, section_id, student_id, level, message, message_purged_at, interpersonal_harm, created_at",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (targetSection) query = query.eq("section_id", targetSection.id);
  if (levelFilter) query = query.eq("level", levelFilter);

  const { data, error } = await query;
  if (error) throw new Error(`Could not load distress events: ${error.message}`);
  const rows = (data ?? []) as Row[];

  console.log(
    `\nDistress events, last ${sinceDays} day(s)${targetSection ? ` for ${targetSection.label}` : ""}${levelFilter ? `, level=${levelFilter}` : ""}\n`,
  );

  if (rows.length === 0) {
    console.log("  No events logged in this window.\n");
  } else {
    for (const r of rows) {
      const who = r.student_id ? r.student_id.slice(0, 8) : "anonymous";
      const body = r.message ?? (r.message_purged_at ? "[message purged per retention policy]" : "[no message stored]");
      const harmTag = r.interpersonal_harm ? "  [INTERPERSONAL HARM]" : "";
      console.log(
        `  ${fmt(r.created_at)}  ${r.level.padEnd(17)} ${nameById.get(r.section_id ?? "") ?? "(unattributed section)"}  student=${who}${harmTag}`,
      );
      console.log(`      ${body.replace(/\s+/g, " ").slice(0, 300)}\n`);
    }
  }

  // Level summary.
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.level] = (acc[r.level] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  Totals: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}  (${rows.length} event(s))`,
  );

  // Interpersonal-harm events bypass the pattern threshold entirely and are
  // surfaced on FIRST occurrence. The 3-in-7-days rule exists to filter
  // noise from ordinary wellbeing struggle; that reasoning does not apply to
  // a disclosure of harassment, assault, discrimination, stalking, or
  // dating or domestic violence, where the obligation to know arises the
  // first time rather than the third.
  //
  // Note precisely what "bypass" means here: this makes the event appear on
  // first occurrence in THIS output. It does not send anything to anyone.
  // There is no delivery channel, so visibility is bounded by how often this
  // script is actually run.
  const harmEvents = rows.filter((r) => r.interpersonal_harm);
  if (harmEvents.length) {
    console.log(
      `\n  INTERPERSONAL HARM: ${harmEvents.length} event(s), shown on first occurrence (pattern threshold bypassed):`,
    );
    for (const r of harmEvents) {
      const who = r.student_id ? r.student_id.slice(0, 8) : "anonymous";
      console.log(
        `    ${fmt(r.created_at)}  ${r.level}  ${nameById.get(r.section_id ?? "") ?? "(unattributed section)"}  student=${who}`,
      );
    }
  }

  // Pattern check. Only identified students can be tracked across events;
  // anonymous sessions are unlinkable by construction, so a recurring
  // anonymous pattern is invisible here and the in-conversation response
  // remains the only intervention for those.
  const windowStart = Date.now() - PATTERN_WINDOW_DAYS * 86_400_000;
  const byStudent = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.student_id) continue;
    if (!r.section_id) continue; // unattributed events cannot be grouped
    if (!PATTERN_LEVELS.includes(r.level)) continue;
    if (new Date(r.created_at).getTime() < windowStart) continue;
    const key = `${r.student_id}|${r.section_id}`;
    byStudent.set(key, [...(byStudent.get(key) ?? []), r]);
  }

  const flagged = [...byStudent.entries()].filter(([, rs]) => rs.length >= PATTERN_COUNT);
  if (flagged.length) {
    console.log(
      `\n  PATTERN: ${flagged.length} student(s) at or above ${PATTERN_COUNT} events (${PATTERN_LEVELS.join("/")}) in ${PATTERN_WINDOW_DAYS} days:`,
    );
    for (const [key, rs] of flagged) {
      const [sid, cid] = key.split("|");
      console.log(`    student=${sid.slice(0, 8)} course=${nameById.get(cid) ?? "(unattributed section)"} events=${rs.length}`);
    }
  }

  const anonCount = rows.filter((r) => !r.student_id).length;
  if (anonCount) {
    console.log(
      `\n  Note: ${anonCount} event(s) came from anonymous sessions and cannot be pattern-tracked or followed up.`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
