-- Two direct-entry configuration changes, following the same interim pattern
-- already used for the distress log reader commitment: the operator sets
-- values in the database, and there is deliberately no UI and no new
-- authentication to support them.

-- 1. Designate the responsible party for MKTG365 escalations.
--
-- Setting this column IS the mechanism. escalation_enabled is generated from
-- it (see 20260906034705) and flips to true automatically, which is exactly
-- why there is no second flag that could disagree with this one.
--
-- Recorded so the reasoning is not lost: the project owner is named here as
-- instructor of record for this course. That makes the same person both the
-- escalation recipient and the committed distress-log reader
-- (distress_log_reader_email, set in 20260906040732). That is a single point
-- of failure for this course's entire human-in-the-loop story, acceptable
-- while enrollment is zero and the course is gated, and worth revisiting
-- before real students arrive or if a separate instructor is onboarded.
update public.courses
  set escalation_recipient_email = 'goalkeeper.dielmann@gmail.com'
  where name = 'MKTG365';

-- 2. On/off control for the topic-listing feature.
--
-- Default false, and false is the only value with any current meaning: the
-- feature is unbuilt and remains blocked. This column exists so the decision
-- has somewhere to live other than a conversation, and so that enabling it
-- later is a deliberate per-course act rather than a global switch.
--
-- Setting this true today changes nothing, and specifically:
--   * it does NOT lift the assessment_scope retrieval exclusion applied in
--     20260906033122, which closed a live leak and stands on its own;
--   * it does NOT resolve the open Section 3.8 question about whether
--     assessment identity can be system-reported at all, which is the actual
--     blocker and needs infrastructure that does not exist.
-- Anyone flipping this expecting the feature to appear should read the
-- blocked-feature entry in SESSION_NOTES.md first.
alter table public.courses
  add column if not exists topic_listing_enabled boolean not null default false;

comment on column public.courses.topic_listing_enabled is
  'Per-course on/off control for the topic-listing feature. Default false. Set by direct database entry only. Currently inert: the feature is unbuilt and blocked on the Section 3.8 system-reported assessment identity question, and this flag does not lift the assessment_scope retrieval exclusion.';
