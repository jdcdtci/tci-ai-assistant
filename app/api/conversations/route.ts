import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getSupabaseServiceClient } from "@/lib/supabase";

// Listing and creating conversations.
//
// Every read here is gated twice: can_access_section decides entitlement in
// the database, and the query is additionally constrained to this session's
// own student_id. Neither alone is sufficient. Entitlement without ownership
// would let one enrolled student read another's transcripts; ownership
// without entitlement would keep serving transcripts after a section closed,
// which is exactly the access the retention rule removes at close.
async function resolveCaller(section_id: string | null) {
  const supabaseAuth = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  if (!user?.email || !user.id) {
    return { error: NextResponse.json({ error: "You must be signed in." }, { status: 401 }) };
  }
  if (!section_id) {
    return { error: NextResponse.json({ error: "section_id is required." }, { status: 400 }) };
  }

  const supabase = getSupabaseServiceClient();
  const { data: allowed, error: accessError } = await supabase.rpc("can_access_section", {
    p_student_email: user.email,
    p_section_id: section_id,
  });

  if (accessError) {
    return { error: NextResponse.json({ error: "Could not verify access right now." }, { status: 503 }) };
  }
  if (allowed !== true) {
    return { error: NextResponse.json({ error: "You do not have access to this section." }, { status: 401 }) };
  }

  return { supabase, studentId: user.id, sectionId: section_id };
}

export async function GET(request: NextRequest) {
  const caller = await resolveCaller(request.nextUrl.searchParams.get("section_id"));
  if (caller.error) return caller.error;

  const { supabase, studentId, sectionId } = caller;

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("student_id", studentId)
    .eq("section_id", sectionId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: "Could not load your conversations right now." }, { status: 503 });
  }

  return NextResponse.json({ conversations: data ?? [] });
}

export async function POST(request: NextRequest) {
  let body: { section_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const caller = await resolveCaller(body.section_id ?? null);
  if (caller.error) return caller.error;

  const { supabase, studentId, sectionId } = caller;

  // title is left null deliberately. It is derived from the first STORED
  // user message after the first exchange completes, which is what keeps a
  // distress opening from ever reaching this column.
  const { data, error } = await supabase
    .from("conversations")
    .insert({ section_id: sectionId, student_id: studentId })
    .select("id, title, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: "Could not start a new conversation right now." }, { status: 503 });
  }

  return NextResponse.json({ conversation: data });
}
