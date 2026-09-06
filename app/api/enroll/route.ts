import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getSupabaseServiceClient } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  const supabaseAuth = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  // Identity comes from the verified session, never from the request body:
  // a client-supplied email would be trivially spoofable.
  if (!user?.email) {
    return NextResponse.json({ error: "You must be signed in to enroll in a course." }, { status: 401 });
  }

  const { join_code } = await request.json();

  if (!join_code || typeof join_code !== "string") {
    return NextResponse.json({ error: "A join code is required." }, { status: 400 });
  }

  const supabase = getSupabaseServiceClient();

  // Join codes now identify a SECTION, not a course. They are globally
  // unique rather than unique per course, because a student types a code
  // with no course context, so it must resolve to exactly one section.
  const { data: section, error: sectionError } = await supabase
    .from("sections")
    .select("id, label, starts_at, ends_at, courses(name)")
    .eq("join_code", join_code.trim())
    .maybeSingle();

  if (sectionError) {
    return NextResponse.json({ error: "Could not look up that join code right now." }, { status: 500 });
  }

  if (!section) {
    return NextResponse.json({ error: "That join code doesn't match any section." }, { status: 404 });
  }

  // A section that has not begun is not enterable. Nothing enforced this
  // before, because only expiry existed.
  if (section.starts_at && new Date(section.starts_at) > new Date()) {
    return NextResponse.json({ error: "This section hasn't started yet." }, { status: 400 });
  }

  if (section.ends_at && new Date(section.ends_at) < new Date()) {
    return NextResponse.json({ error: "This join code has expired." }, { status: 400 });
  }

  const courseName = (section.courses as unknown as { name: string } | null)?.name ?? "";

  const { data: enrollment, error: insertError } = await supabase
    .from("enrollments")
    .insert({ student_email: user.email, section_id: section.id })
    .select("id, section_id, enrolled_at")
    .single();

  if (!insertError) {
    return NextResponse.json({
      enrollment,
      section: { id: section.id, label: section.label, courseName },
    });
  }

  // 23505 = unique_violation on (student_email, section_id): this student is
  // already enrolled in this section. Not an error condition, per spec --
  // return the existing enrollment instead of failing.
  if (insertError.code === "23505") {
    const { data: existing, error: lookupError } = await supabase
      .from("enrollments")
      .select("id, section_id, enrolled_at")
      .eq("student_email", user.email)
      .eq("section_id", section.id)
      .single();

    if (lookupError) {
      return NextResponse.json({ error: "Could not confirm your existing enrollment right now." }, { status: 500 });
    }

    return NextResponse.json({
      enrollment: existing,
      section: { id: section.id, label: section.label, courseName },
    });
  }

  // Distinct refusals raised by the enrollment triggers, surfaced with their
  // real reason rather than the generic message. Previously a closed course
  // produced only "Could not create your enrollment right now", which was
  // logged as a known rough edge; sections is the right moment to fix it.
  if (insertError.code === "23514") {
    return NextResponse.json({ error: insertError.message }, { status: 409 });
  }

  return NextResponse.json({ error: "Could not create your enrollment right now." }, { status: 500 });
}
