-- student_interaction_history: the assistant's working memory of a
-- specific student's progress in a specific course. This is distinct from
-- an audit log (a record of what happened, for review after the fact) --
-- this table is read by the assistant during live conversations to
-- inform how it responds (e.g. "this student already struggled with X,
-- don't assume they've mastered it").
create table if not exists student_interaction_history (
  -- Surrogate primary key.
  id uuid primary key default gen_random_uuid(),

  -- The student this interaction belongs to. Plain uuid with no foreign
  -- key, since no local students/users table exists yet in this schema --
  -- same pattern as knowledge_documents.course_id.
  student_id uuid not null,

  -- The course this interaction occurred in.
  course_id uuid not null,

  -- The concept or topic discussed in this interaction (e.g. "problem
  -- definition", "sampling frame error").
  concept text not null,

  -- Whether a comprehension check on this concept passed or failed.
  -- Left nullable with no default: not every discussion of a concept
  -- includes a comprehension check, so null means "no check was given,"
  -- not "failed." Only set true/false when a check actually occurred.
  comprehension_check_passed boolean,

  -- When this interaction occurred.
  created_at timestamptz not null default now()
);

comment on table student_interaction_history is
  'Working memory of a student''s progress in a course (concepts discussed, comprehension check results), actively read by the assistant during conversations. Distinct from an audit log.';

-- Supports the assistant's primary access pattern: "what does this student
-- already know in this course" looked up live during a chat request.
create index if not exists student_interaction_history_student_course_idx
  on student_interaction_history (student_id, course_id);

-- Only ever written to and read by our own server-side route using the
-- service_role key, which bypasses RLS by design. As with
-- knowledge_documents/knowledge_chunks, RLS is enabled with no
-- anon/authenticated policy (default-deny) and an explicit service_role
-- policy documenting intent, since the anon key is not secret and
-- Supabase auto-exposes every public-schema table over its REST API.
alter table public.student_interaction_history enable row level security;

create policy "Service role full access"
  on public.student_interaction_history
  for all
  to service_role
  using (true)
  with check (true);
