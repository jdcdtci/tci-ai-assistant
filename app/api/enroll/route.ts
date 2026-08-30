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

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("id, name, expires_at")
    .eq("join_code", join_code.trim())
    .maybeSingle();

  if (courseError) {
    return NextResponse.json({ error: "Could not look up that join code right now." }, { status: 500 });
  }

  if (!course) {
    return NextResponse.json({ error: "That join code doesn't match any course." }, { status: 404 });
  }

  if (course.expires_at && new Date(course.expires_at) < new Date()) {
    return NextResponse.json({ error: "This join code has expired." }, { status: 400 });
  }

  const { data: enrollment, error: insertError } = await supabase
    .from("enrollments")
    .insert({ student_email: user.email, course_id: course.id })
    .select("id, course_id, enrolled_at")
    .single();

  if (!insertError) {
    return NextResponse.json({ enrollment, course: { id: course.id, name: course.name } });
  }

  // 23505 = unique_violation on (student_email, course_id): this student is
  // already enrolled in this course. Not an error condition, per spec --
  // return the existing enrollment instead of failing.
  if (insertError.code === "23505") {
    const { data: existing, error: lookupError } = await supabase
      .from("enrollments")
      .select("id, course_id, enrolled_at")
      .eq("student_email", user.email)
      .eq("course_id", course.id)
      .single();

    if (lookupError) {
      return NextResponse.json({ error: "Could not confirm your existing enrollment right now." }, { status: 500 });
    }

    return NextResponse.json({ enrollment: existing, course: { id: course.id, name: course.name } });
  }

  return NextResponse.json({ error: "Could not create your enrollment right now." }, { status: 500 });
}
