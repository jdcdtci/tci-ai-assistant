import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getSupabaseServiceClient } from "@/lib/supabase";

// Resolves the sections this student is already enrolled in and can still
// reach, so a page reload does not ask for a join code they have already
// used.
//
// This exists because `section` lived only in React state: reloading dropped
// it and the join screen reappeared. Conversation history cannot function
// without this read either, since a transcript cannot be listed before its
// section is known.
export async function GET() {
  const supabaseAuth = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  // Identity from the verified session, never from the request.
  if (!user?.email) {
    return NextResponse.json({ sections: [] });
  }

  const supabase = getSupabaseServiceClient();

  const { data: rows, error } = await supabase
    .from("enrollments")
    .select("section_id, sections(id, label, courses(name))")
    .eq("student_email", user.email);

  if (error) {
    return NextResponse.json({ error: "Could not load your enrollment right now." }, { status: 503 });
  }

  // Entitlement is still decided by the database, one section at a time.
  // An enrollments row is not by itself permission: can_access_section also
  // accounts for start and end dates and access mode, and returns false once
  // a section has closed. Filtering here means a closed section simply does
  // not come back, rather than coming back and failing later.
  const sections: { id: string; label: string; courseName: string }[] = [];

  for (const row of rows ?? []) {
    const section = row.sections as unknown as
      | { id: string; label: string; courses: { name: string } | null }
      | null;
    if (!section) continue;

    const { data: allowed } = await supabase.rpc("can_access_section", {
      p_student_email: user.email,
      p_section_id: section.id,
    });

    if (allowed === true) {
      sections.push({
        id: section.id,
        label: section.label,
        courseName: section.courses?.name ?? "",
      });
    }
  }

  return NextResponse.json({ sections });
}
