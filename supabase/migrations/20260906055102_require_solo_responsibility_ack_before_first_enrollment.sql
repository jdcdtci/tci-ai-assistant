-- Forces the single-point-of-failure question at the moment it stops being
-- hypothetical, instead of depending on someone remembering to re-read a
-- note at the right time.
--
-- WHY THE HOOK IS ENROLLMENT AND NOT access_mode
--
-- The obvious hook, "changing access_mode away from closed", does not work
-- for the course this actually concerns: MKTG365 is already 'join_code', so
-- that transition is one it made long ago. A constraint there would protect
-- every future course and silently skip the present one. The moment that
-- genuinely matters is the FIRST REAL ENROLLMENT, because that is when a
-- person exists who can disclose something only one individual is positioned
-- to see, respond to, and act on.
--
-- WHY FREE TEXT AND NOT A BOOLEAN
--
-- A boolean is rubber-stampable: it can be set in a second without anyone
-- thinking about the question. Requiring a written statement of who else
-- holds a role and who the backup reader is makes the acknowledgement carry
-- the reasoning, and lets a future reader see what was actually decided
-- rather than that a box was ticked. The length floor is deliberately modest
-- but non-zero, so "ok" does not satisfy it.
--
-- WHEN IT APPLIES
--
-- Only when the escalation recipient and the distress-log reader are the
-- same person. If two different humans hold those roles, the concern this
-- guards against does not exist and no acknowledgement is required. That
-- also means the natural way to clear this gate permanently is to give the
-- two roles to two people, which is the outcome the underlying note wants.

alter table public.courses
  add column if not exists solo_responsibility_ack text;

alter table public.courses
  add column if not exists solo_responsibility_ack_at timestamptz;

comment on column public.courses.solo_responsibility_ack is
  'Written acknowledgement, required before this course may accept its first enrollment while one person is both escalation_recipient_email and distress_log_reader_email. Must state who else holds a role in this course and who the backup distress-log reader is. Free text on purpose: a boolean is rubber-stampable.';

alter table public.courses
  drop constraint if exists courses_solo_ack_complete;
alter table public.courses
  add constraint courses_solo_ack_complete
  check ((solo_responsibility_ack is null) = (solo_responsibility_ack_at is null));

alter table public.courses
  drop constraint if exists courses_solo_ack_substantive;
alter table public.courses
  add constraint courses_solo_ack_substantive
  check (solo_responsibility_ack is null or length(btrim(solo_responsibility_ack)) >= 40);

create or replace function reject_enrollment_without_solo_ack()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c record;
begin
  select escalation_recipient_email, distress_log_reader_email, solo_responsibility_ack
    into c
  from public.courses
  where id = new.course_id;

  if c is null then
    return new; -- course existence is the other trigger's concern
  end if;

  if c.escalation_recipient_email is not null
     and c.escalation_recipient_email is not distinct from c.distress_log_reader_email
     and c.solo_responsibility_ack is null
  then
    raise exception
      'Course % cannot accept enrollments yet: the escalation recipient and the distress-log reader are the same person (%), and courses.solo_responsibility_ack has not been written. Record who else holds a role in this course and who the backup distress-log reader is, then retry.',
      new.course_id, c.escalation_recipient_email
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists enrollments_require_solo_ack on public.enrollments;
create trigger enrollments_require_solo_ack
  before insert on public.enrollments
  for each row execute function reject_enrollment_without_solo_ack();

-- Verified on application: enrollment blocked while the acknowledgement was
-- absent, a one-word acknowledgement rejected by the length floor, and
-- enrollment proceeding once a real statement was recorded. The test
-- acknowledgement and test enrollment were both removed afterward, so the
-- gate is armed.
