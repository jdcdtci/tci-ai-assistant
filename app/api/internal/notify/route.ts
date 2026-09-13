import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase";
import { runEscalationSweep } from "@/lib/notifications";

// The escalation sweep endpoint, called every ten minutes by pg_cron via
// pg_net.
//
// AUTHENTICATION IS IN MIDDLEWARE, NOT HERE. /api/internal/ is exempted from
// the site-password gate and required to carry NOTIFY_SWEEP_SECRET as a
// bearer instead, compared in constant time, with an unset secret meaning 404
// rather than open. This handler is therefore only ever reached by a caller
// that already proved it holds that secret.
//
// Scheduling lives in Postgres rather than Vercel Cron because the account is
// on the Hobby plan, which allows one cron run per day. A six-hour
// deduplication window needs a sweep far more often than that.
//
// POST only. pg_net posts, and a GET-able trigger is one accidental link
// preview away from firing.
export async function POST() {
  const supabase = getSupabaseServiceClient();

  try {
    const result = await runEscalationSweep(supabase);
    return NextResponse.json(result);
  } catch (err) {
    // The sweep records its own per-notification failures. This catches a
    // failure of the sweep itself, which has no single notification to
    // attribute to, so it is logged and returned rather than written to
    // notification_delivery_failures with an invented section and student.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[notify] sweep failed: ${detail}`);
    return NextResponse.json({ error: "Sweep failed.", detail }, { status: 500 });
  }
}
