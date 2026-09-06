-- Makes "a course may not admit students unless a named human has committed
-- to reading its distress log" a database guarantee rather than a policy two
-- people are expected to remember.
--
-- WHY THIS IS IN THE DATABASE
--
-- Stage 2 exists partly because courses.escalation_enabled and
-- escalation_recipient_email looked like working infrastructure while having
-- no consumer anywhere in the codebase. A distress log with nobody committed
-- to reading it would be that same defect one layer over: a safety feature
-- that is real in the schema and absent in practice. A rule held only in
-- notes survives exactly as long as everyone's memory does, and the failure
-- mode here is a real student in distress writing into a system where
-- nothing on the other end is watching.
--
-- This is also why 'closed' is enforced on the enrollments table itself
-- rather than in the enrollment route. No application code reads access_mode
-- today (verified: the only occurrence in TypeScript is a comment in
-- middleware.ts), so a route-level check would be both new and forgettable.
-- A trigger holds for every call site that exists now or later.

-- 1. Institution-specific crisis resource, populated when a real contact is
-- confirmed. The 988 baseline is complete and safe on its own, so null here
-- is a working state rather than a gap.
alter table public.courses
  add column if not exists institutional_crisis_resource text;

comment on column public.courses.institutional_crisis_resource is
  'Institution-specific crisis or counseling contact for this course, shown in addition to the 988 baseline. Null means only the 988 baseline is shown, which is a complete and safe response on its own. Never populate with a guessed or unverified number.';

-- 2. The commitment itself: who reads this course's distress log, how often.
alter table public.courses
  add column if not exists distress_log_reader_email text;

alter table public.courses
  add column if not exists distress_log_review_interval_hours integer;

comment on column public.courses.distress_log_reader_email is
  'The named human who has committed to reading this course distress log. Set together with distress_log_review_interval_hours; a course cannot be opened to students while either is null.';

comment on column public.courses.distress_log_review_interval_hours is
  'The committed maximum interval between reviews of this course distress log, in hours (24 = daily). Set together with distress_log_reader_email.';

-- Both or neither. Same lesson as the escalation_enabled fix immediately
-- before this migration: two fields expressing one commitment must not be
-- able to disagree, and a half-populated commitment is not a commitment.
alter table public.courses
  drop constraint if exists courses_distress_reader_complete;
alter table public.courses
  add constraint courses_distress_reader_complete
  check ((distress_log_reader_email is null) = (distress_log_review_interval_hours is null));

alter table public.courses
  drop constraint if exists courses_distress_interval_positive;
alter table public.courses
  add constraint courses_distress_interval_positive
  check (distress_log_review_interval_hours is null or distress_log_review_interval_hours > 0);

-- 3. 'closed' becomes a real access mode meaning no student access at all,
-- and becomes the default.
--
-- This reverses the original reasoning for defaulting access_mode to
-- 'public', which was that the permissive default required no explicit
-- choice and made internal testing frictionless. That reasoning was sound
-- when the only cost of a thoughtlessly-created course was an open test
-- course. It is not sound once a course admitting students implies a
-- standing human obligation to watch for distress. The safe default and the
-- convenient default point in opposite directions here, and safety wins:
-- a course created without thought now admits nobody.
alter table public.courses
  drop constraint if exists courses_access_mode_check;
alter table public.courses
  add constraint courses_access_mode_check
  check (access_mode in ('closed', 'public', 'join_code', 'institutional'));

alter table public.courses
  alter column access_mode set default 'closed';

-- 4. Record the standing commitment for MKTG365 before the gate is added, so
-- the existing row satisfies it rather than being forced closed. The project
-- owner named himself as the responsible human, committing to a daily check.
update public.courses
  set distress_log_reader_email = 'goalkeeper.dielmann@gmail.com',
      distress_log_review_interval_hours = 24
  where name = 'MKTG365';

-- 5. The gate.
alter table public.courses
  drop constraint if exists courses_access_requires_distress_reader;
alter table public.courses
  add constraint courses_access_requires_distress_reader
  check (
    access_mode = 'closed'
    or (distress_log_reader_email is not null
        and distress_log_review_interval_hours is not null)
  );

-- 6. 'closed' must actually close the door, not merely declare it.
create or replace function reject_enrollment_when_course_closed()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  mode text;
begin
  select access_mode into mode from public.courses where id = new.course_id;

  if mode is null then
    raise exception 'Enrollment refers to a course that does not exist: %', new.course_id;
  end if;

  if mode = 'closed' then
    raise exception 'Course % is closed to student access and cannot accept enrollments.', new.course_id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists enrollments_reject_when_course_closed on public.enrollments;
create trigger enrollments_reject_when_course_closed
  before insert on public.enrollments
  for each row execute function reject_enrollment_when_course_closed();

-- KNOWN ROUGH EDGE, deliberately not smoothed here: /api/enroll does not
-- special-case this failure, so an enrollment attempt against a closed
-- course surfaces as its generic "Could not create your enrollment right
-- now" message rather than an explanatory one. The safety property holds
-- (it fails closed), and improving the message is an API contract change
-- that requires a signed-in UI test under this project's standing rule.
-- Worth doing, not worth blocking this migration on.
