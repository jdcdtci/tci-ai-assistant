-- Distress event log, plus its enforced retention.
--
-- WHAT THIS TABLE IS, AND WHAT IT IS NOT
--
-- It is a record for human follow-up and defensibility. It is NOT a response
-- mechanism. The in-conversation response is the actual intervention, and
-- nothing about the existence of this table should be read as a safety net.
-- As of this migration the only reader is the course's committed
-- distress_log_reader_email running a manual query; there is no dashboard,
-- no alerting, and no operator backend with a working login.
--
-- ONLY ACTIONABLE LEVELS ARE STORABLE
--
-- The level CHECK admits only personal_distress, possible_risk, and crisis.
-- 'none' and 'academic_frustration' are deliberately not representable.
-- Logging every time a student says the workload is hard would accumulate
-- into a surveillance record of ordinary struggle, which is both a privacy
-- harm and useless: struggle patterns belong to the interaction-history
-- path, and proactive outreach on them is stage 4's problem, not this
-- table's.

create table if not exists public.distress_events (
  id uuid primary key default gen_random_uuid(),

  -- Deleting a course must not silently destroy its distress records.
  course_id uuid not null references public.courses(id) on delete restrict,

  -- Null for anonymous sessions. Those cannot be followed up or
  -- pattern-tracked, which is exactly why the in-conversation response has
  -- to be a complete intervention on its own rather than a handoff.
  --
  -- Deliberately not FK-coupled to auth.users: the identity model is
  -- Phase 3 work and Phase 3 is paused, so binding this table to those
  -- decisions now would couple a shipped safety feature to indefinitely
  -- deferred work.
  student_id uuid,

  level text not null check (level in ('personal_distress', 'possible_risk', 'crisis')),

  -- The student's actual words. A human following up needs what was really
  -- said; a paraphrase distorts the thing they most need to read
  -- accurately. Purged on the schedule below.
  message text,

  -- Set when message is nulled by the purge, so "never stored" stays
  -- distinguishable from "stored and later purged".
  message_purged_at timestamptz,

  created_at timestamptz not null default now()
);

comment on table public.distress_events is
  'Record of distress signals detected in student messages. This is a record for human follow-up and defensibility, NOT a response mechanism: the in-conversation response is the actual intervention. Nothing here should be read as a safety net.';

-- Pattern detection: level 3 or higher events for one identified student in
-- one course inside a rolling window.
create index if not exists distress_events_student_course_time_idx
  on public.distress_events (student_id, course_id, created_at desc)
  where student_id is not null;

-- Retention sweep.
create index if not exists distress_events_created_at_idx
  on public.distress_events (created_at);

-- Standing convention for every table in this project: RLS on, default-deny
-- for anon/authenticated, one explicit service_role policy. Verified via
-- pg_policies after applying, not assumed.
alter table public.distress_events enable row level security;

create policy "Service role full access"
  on public.distress_events
  for all
  to service_role
  using (true)
  with check (true);

-- INTERIM RETENTION, decided deliberately and NOT tied to the lti_launches
-- retention question, which has no scheduled return date while Phase 3 is
-- paused. Two tiers, because the sensitive part and the useful part have
-- different lifetimes: a distressed student's actual words are purged well
-- before the metadata that supports pattern detection and defensibility.
--
--   message text     -> nulled at 30 days  (exceeds the 7-day pattern
--                                           window with margin, and matches
--                                           the numeric precedent in 3.2)
--   whole row        -> deleted at 180 days
--
-- Scheduled rather than left to intention. An unenforced retention policy
-- is the same defect class as escalation config with no consumer.
create or replace function public.purge_distress_events()
returns void
language sql
security definer
set search_path = public
as $$
  with purged as (
    update public.distress_events
      set message = null,
          message_purged_at = now()
    where message is not null
      and created_at < now() - interval '30 days'
    returning 1
  ),
  deleted as (
    delete from public.distress_events
    where created_at < now() - interval '180 days'
    returning 1
  )
  select;
$$;

comment on function public.purge_distress_events is
  'Interim retention: nulls message text at 30 days, deletes rows at 180 days. Scheduled, not left to intention, because an unenforced retention policy is the same defect class as escalation config with no consumer.';

-- Scheduling, run once against the live project (pg_cron 1.6.4 was verified
-- available before relying on it):
--
--   create extension if not exists pg_cron;
--   select cron.schedule('purge-distress-events', '17 3 * * *',
--                        $$select public.purge_distress_events()$$);
--
-- Confirmed present and active = true in cron.job.
