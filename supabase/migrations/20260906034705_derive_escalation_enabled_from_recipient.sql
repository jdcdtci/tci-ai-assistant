-- Makes escalation_enabled derived rather than independently settable.
--
-- THE DEFECT
--
-- courses previously carried escalation_enabled as its own boolean, with a
-- CHECK constraint asserting that it could not be true unless
-- escalation_recipient_email was set. That CHECK only enforced one
-- direction. The other direction was free to drift: a course could carry a
-- real recipient address and still have escalation_enabled false, which is
-- exactly the state MKTG365 was found in (recipient null, flag false, and
-- per spec 12.2a a for-credit course with a professor of record should
-- default to enabled). Two fields expressing one fact can disagree, and a
-- CHECK that constrains only the dangerous direction still leaves the
-- system able to say two different things about whether a student in
-- distress has anywhere to go.
--
-- THE FIX
--
-- escalation_enabled becomes a GENERATED ALWAYS ... STORED column computed
-- from escalation_recipient_email. The two can no longer disagree, even
-- transiently, and a direct write to escalation_enabled is rejected by
-- Postgres rather than being silently accepted and later contradicted. This
-- is the same instinct as the RLS and answer_bearing decisions elsewhere in
-- this project: prefer a structure that cannot express the wrong state over
-- a rule someone has to remember.
--
-- The old CHECK is dropped because it is now unsatisfiable-by-construction
-- rather than merely enforced: the condition it asserted is a theorem about
-- the generation expression, not a constraint that could fail.
--
-- HOW ESCALATION IS TURNED ON NOW
--
-- Set escalation_recipient_email. Null it out to turn escalation off. There
-- is no other write path, deliberately.
--
-- ON THE WORD "VERIFIED"
--
-- This derives enablement from the *presence* of a recipient, which treats
-- "an operator deliberately entered this address" as equivalent to "a real
-- person agreed to receive escalations." That equivalence holds while the
-- only write path is direct database entry by the operator, which is the
-- current and expected state until the professor-facing dashboard is built.
-- It stops holding the moment a form lets someone else type an address, at
-- which point spec 12.2a's "only if a real person has agreed to receive it"
-- needs its own representation, most likely a separate confirmation
-- timestamp folded into this same generation expression. Revisit this
-- comment when that dashboard ships; do not let a typed form field silently
-- inherit the meaning "someone agreed."

-- Named automatically when the table was created; this is the escalation
-- CHECK, not the access_mode or program ones.
alter table public.courses
  drop constraint if exists courses_check;

alter table public.courses
  drop column if exists escalation_enabled;

alter table public.courses
  add column escalation_enabled boolean
    not null
    generated always as (escalation_recipient_email is not null) stored;

comment on column public.courses.escalation_enabled is
  'Derived, never set directly: true exactly when escalation_recipient_email is present. A generated column rather than an independent flag plus a CHECK, so the two cannot disagree even transiently. To enable escalation, set escalation_recipient_email; to disable it, null that column out.';

comment on column public.courses.escalation_recipient_email is
  'The real person who has agreed to receive escalations for this course. Setting this is what enables escalation (see escalation_enabled). Null means no designated responsible party, which per spec 12.2a is the correct state until someone has actually agreed, since escalation with nowhere real to go is worse than none.';
