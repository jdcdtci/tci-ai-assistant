-- A second signal captured at classification time, independent of level.
--
-- WHY IT IS SEPARATE FROM level RATHER THAN A NEW LEVEL
--
-- The level scale measures how much distress a student is expressing. This
-- measures what the disclosed content is ABOUT. They are orthogonal: a
-- student can disclose harassment calmly, or be in acute distress for
-- reasons that involve no interpersonal harm at all. Collapsing the two
-- would have forced a new response category, which is explicitly not wanted:
-- the existing personal_distress and possible_risk responses remain the
-- student-facing behaviour for these disclosures, unchanged. No new response
-- text, no new category.
--
-- WHAT IT CHANGES
--
-- Notification timing only. The 3-events-in-7-days pattern threshold exists
-- to protect against noise from ordinary wellbeing struggle. That reasoning
-- does not apply to a disclosure that also indicates harassment, sexual
-- assault, discrimination, stalking, or dating or domestic violence, where
-- the obligation to know arises on the first occurrence rather than the
-- third. When this is true, the pattern requirement is bypassed.
--
-- WHAT IT DOES NOT CHANGE, STATED SO IT IS NOT ASSUMED
--
-- There is still no delivery channel. Bypassing the pattern threshold makes
-- an event surface on FIRST occurrence in the review script; it does not
-- send anything to anyone. Against the committed 24-hour review cadence,
-- worst-case visibility is about a day. This is an occurrence-count change,
-- not a latency change, and "immediate" must not be read as "delivered".
--
-- It also does not unblock the separate Title IX work (a dedicated detection
-- layer, email-and-transcript delivery, syllabus-based coordinator lookup).
-- That remains blocked on confirming whether MKTG365's syllabus names a
-- coordinator and on verifying that contact from a real institutional
-- source.
alter table public.distress_events
  add column if not exists interpersonal_harm boolean not null default false;

comment on column public.distress_events.interpersonal_harm is
  'True when the disclosed content indicates interpersonal harm (harassment, sexual assault, discrimination, stalking, dating or domestic violence), as distinct from general wellbeing distress. Independent of level. When true, the 3-in-7-days notification pattern threshold is bypassed and the event is surfaced on first occurrence. Does not change any student-facing response.';

-- Supports "show me every interpersonal-harm disclosure" without scanning
-- the whole table.
create index if not exists distress_events_interpersonal_harm_idx
  on public.distress_events (created_at desc)
  where interpersonal_harm;
