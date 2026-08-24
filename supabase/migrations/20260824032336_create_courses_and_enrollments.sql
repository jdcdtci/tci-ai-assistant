-- courses: a course offered through the assistant, and the access rules
-- that govern who can reach it. This is configuration, not content: the
-- actual course material still lives in knowledge_documents/knowledge_chunks,
-- linked by course_id there.
create table if not exists courses (
  -- Surrogate primary key, referenced by enrollments.course_id.
  id uuid primary key default gen_random_uuid(),

  -- Human-readable course name, shown to students and staff.
  name text not null,

  -- The code students enter to enroll under access_mode = 'join_code'.
  -- Nullable: a 'public' or 'institutional' course may not use a join
  -- code at all. Unique whenever set, so a code always identifies exactly
  -- one course; Postgres unique constraints permit multiple nulls, so
  -- courses without a code don't collide with each other.
  join_code text unique,

  -- When this course row was created.
  created_at timestamptz not null default now(),

  -- When this course (and its join_code, if any) stops being usable for
  -- enrollment. Nullable: a course with no expiration stays open
  -- indefinitely. Enforcing the cutoff is application logic; this column
  -- just records the boundary.
  expires_at timestamptz,

  -- How students reach this course. 'public' needs no enrollment step,
  -- 'join_code' requires entering courses.join_code, 'institutional' is
  -- reserved for a future SSO/roster-based access path.
  access_mode text not null default 'public'
    check (access_mode in ('public', 'join_code', 'institutional')),

  -- Whether this course can escalate a conversation to a real person.
  escalation_enabled boolean not null default false,

  -- The real person who receives an escalation for this course. Required
  -- to be set before escalation_enabled can be true (enforced below), so
  -- escalation can never be silently turned on with nowhere for it to go.
  escalation_recipient_email text,

  -- Structural guarantee, not just an application-level check: escalation
  -- cannot be enabled without a recipient already configured to receive it.
  check (not escalation_enabled or escalation_recipient_email is not null)
);

comment on table courses is
  'Courses offered through the assistant and their access/escalation configuration. Course content lives separately in knowledge_documents/knowledge_chunks.';

-- enrollments: records that a student has enrolled in a course, and how
-- (anonymous public access vs. a verified identity). Distinct from
-- student_interaction_history, which tracks what a student has learned;
-- this table only tracks whether they have access.
create table if not exists enrollments (
  -- Surrogate primary key.
  id uuid primary key default gen_random_uuid(),

  -- The student's verified Google email, if they were logged in when they
  -- enrolled. Null for anonymous access under access_mode = 'public',
  -- where no identity is collected at all.
  student_email text,

  -- The course enrolled in. Deleting a course cascades to its
  -- enrollments, since an enrollment has no meaning without it.
  course_id uuid not null references courses(id) on delete cascade,

  -- When this enrollment was recorded.
  enrolled_at timestamptz not null default now()
);

comment on table enrollments is
  'Records of student access to a course (identified or anonymous). Tracks whether a student has access, not what they have learned -- see student_interaction_history for that.';

-- Supports "who is enrolled in this course" and "what has this student
-- enrolled in", the two natural lookups for this table. Partial index on
-- student_email since it is null for anonymous enrollments.
create index if not exists enrollments_course_id_idx
  on enrollments (course_id);

create index if not exists enrollments_student_email_idx
  on enrollments (student_email)
  where student_email is not null;

-- Only ever written to and read by our own server-side routes using the
-- service_role key, same discipline as every other table in this build:
-- RLS enabled, no anon/authenticated policy (default-deny), explicit
-- service_role policy documenting intent.
alter table public.courses enable row level security;
alter table public.enrollments enable row level security;

create policy "Service role full access"
  on public.courses
  for all
  to service_role
  using (true)
  with check (true);

create policy "Service role full access"
  on public.enrollments
  for all
  to service_role
  using (true)
  with check (true);
