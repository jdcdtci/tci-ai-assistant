import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getSupabaseServiceClient } from "@/lib/supabase";

// One conversation's transcript.
//
// The conversation is fetched first so its section can be read from the row
// rather than accepted from the caller, mirroring how /api/chat derives
// course_id from the section instead of trusting a client-supplied value.
// A caller therefore cannot pair someone else's conversation id with a
// section they happen to be entitled to.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/conversations/[id]">) {
  const { id } = await ctx.params;

  const supabaseAuth = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  if (!user?.email || !user.id) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  const supabase = getSupabaseServiceClient();

  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, section_id, student_id, title, created_at")
    .eq("id", id)
    .maybeSingle();

  if (convError) {
    return NextResponse.json({ error: "Could not load that conversation right now." }, { status: 503 });
  }

  // Ownership and existence produce the SAME response on purpose. A distinct
  // "not yours" would confirm that a given conversation id exists, which is
  // a membership oracle over other students' transcripts.
  if (!conversation || conversation.student_id !== user.id) {
    return NextResponse.json({ error: "No such conversation." }, { status: 404 });
  }

  const { data: allowed, error: accessError } = await supabase.rpc("can_access_section", {
    p_student_email: user.email,
    p_section_id: conversation.section_id,
  });

  if (accessError) {
    return NextResponse.json({ error: "Could not verify access right now." }, { status: 503 });
  }
  if (allowed !== true) {
    return NextResponse.json({ error: "You do not have access to this section." }, { status: 401 });
  }

  const { data: rows, error: msgError } = await supabase
    .from("messages")
    .select("id, role, content, created_at, redacted_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    // Both halves of an exchange share one created_at, because they are one
    // event. Without a tiebreak the order between them is whatever Postgres
    // returns, which put the assistant's reply BEFORE the student's message
    // in observed rows. Descending on role puts 'user' ahead of 'assistant'
    // deterministically, without inventing timestamps that did not happen.
    .order("role", { ascending: false });

  if (msgError) {
    return NextResponse.json({ error: "Could not load that transcript right now." }, { status: 503 });
  }

  // redaction_reason is deliberately NOT selected. It carries one value, so
  // it says nothing the redacted flag does not, and not selecting it keeps
  // the response free of any field whose purpose is to describe why.
  const messages = (rows ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.redacted_at ? null : m.content,
    redacted: m.redacted_at !== null,
    created_at: m.created_at,
  }));

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      section_id: conversation.section_id,
      created_at: conversation.created_at,
    },
    messages,
  });
}
