-- Escalation notification: the delivery half of a signal that has been
-- recorded but undeliverable since it was built.
--
-- Four notification_worthy events were produced during testing on
-- 2026-09-07 with nowhere to go. This gives them somewhere.
--
-- PURELY ADDITIVE AT THE DATABASE LEVEL. Two tables, three functions, one
-- extension, two cron jobs. No ALTER, no DROP, no backfill, no change to any
-- existing table, function, policy or trigger.
--
-- In particular there is deliberately NO notified_at column added to
-- distress_events. That would be an ALTER on an existing table and the
-- difference between additive and not; deduplication reads
-- notification_deliveries instead.
--
-- ============================================================================
-- WHAT AN EMAIL MAY CONTAIN
-- ============================================================================
--
-- Identity and context only: who, which section, when, why the threshold
-- crossed, and a sign-in link. NEVER the student's message text, under any
-- circumstance.
--
-- This is the same principle already applied to conversation history and to
-- the .md export redesign, not a fresh judgement. Email leaves every
-- retention clock this system has: it lands in an inbox with no purge, no
-- access control, and forwarding nobody can see. distress_events already
-- holds the content under a governed clock with a named reader role.
-- Sending the text would duplicate it under a clock belonging to nobody.
--
-- Note what these tables therefore do NOT have: any column capable of
-- holding message content. That is the structural half of the rule.


-- Needed because the scheduler lives in Postgres rather than in Vercel.
-- The account is on the Hobby plan, where Vercel Cron runs once per day,
-- which cannot serve a six-hour deduplication window: a crisis escalation
-- could sit for 24 hours.
create extension if not exists pg_net with schema extensions;


-- ============================================================================
-- notification_deliveries
-- ============================================================================
-- One row per notification actually sent. This table IS the deduplication
-- mechanism: "has this student in this section been notified about within
-- the last six hours" is a query against it.
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),

  section_id uuid not null references public.sections(id) on delete restrict,
  student_id uuid not null,

  -- Who it went to, recorded at send time rather than resolved later: the
  -- accepted escalation recipient can change, and an audit of who was told
  -- what is worthless if it reports today's holder for last month's send.
  recipient_email text not null,

  -- The start of the span this notification covered, and how many qualifying
  -- events fell in it. A count, never the events themselves.
  window_opened_at timestamptz not null,
  event_count integer not null check (event_count > 0),

  sent_at timestamptz not null default now(),

  -- Resend's id for the message, for tracing a delivery complaint back to a
  -- specific send. Not a delivery guarantee.
  provider_message_id text
);

create index if not exists notification_deliveries_dedup_idx
  on public.notification_deliveries (student_id, section_id, sent_at desc);


-- ============================================================================
-- notification_delivery_failures
-- ============================================================================
-- Same pattern as memory_write_failures and history_write_failures, for the
-- same reason: the thing being recorded is that something did NOT happen, so
-- there is no row to mark, and a log line is the easiest output to lose.
--
-- A notification that silently fails is the worst member of that family. The
-- other two lose a record; this one lets a wellbeing escalation evaporate
-- while the system behaves as though someone was told.
create table if not exists public.notification_delivery_failures (
  id uuid primary key default gen_random_uuid(),

  section_id uuid not null references public.sections(id) on delete restrict,
  student_id uuid not null,

  -- Null when the failure is precisely that no recipient could be resolved.
  recipient_email text,

  reason text not null check (
    reason in ('provider_error', 'exception', 'not_configured', 'insert_failed')
  ),

  -- A system error string, never anything the student wrote. Truncated by
  -- the caller, exactly as the other two failure tables are.
  detail text,

  created_at timestamptz not null default now()
);

create index if not exists notification_delivery_failures_created_idx
  on public.notification_delivery_failures (created_at);


-- ============================================================================
-- pending_escalations
-- ============================================================================
-- Who is due a notification right now.
--
-- THE NO-FALLBACK-RECIPIENT RULE IS ENFORCED HERE, IN SQL.
--
-- The join to accepted escalation recipients is an inner join. A section
-- with no accepted recipient produces NO ROW, so the sweep cannot notify
-- anyone about it even if application code tried. There is no fallback
-- address, and no code path that could introduce one without editing this
-- function.
--
-- That matters more than it looks. The risk register is explicit that a
-- section whose students are implicitly promised escalation, with nobody
-- actually obligated to respond, is "worse than no escalation at all". The
-- structural version of that rule is: no accepted recipient, no row.
--
-- DEDUPLICATION: one notification per student per section per six hours.
-- The count is of every qualifying event since the LAST notification, not
-- since an arbitrary six hours ago, so nothing is skipped by a quiet spell.
--
-- CONSEQUENCE WORTH KNOWING: a recipient who accepts the role after events
-- have accumulated receives a count covering all of them on the first sweep.
-- That is deliberate. A safety obligation that begins by hiding what already
-- happened is not one.
--
-- The student's email comes from auth.users, since distress_events carries
-- an auth uid while enrollments carries an email and there is no direct join
-- between them.
create or replace function public.pending_escalations()
returns table (
  section_id uuid,
  student_id uuid,
  student_email text,
  recipient_email text,
  event_count bigint,
  window_opened_at timestamptz,
  latest_reason text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with last_sent as (
    select nd.student_id, nd.section_id, max(nd.sent_at) as sent_at
    from public.notification_deliveries nd
    group by nd.student_id, nd.section_id
  ),
  candidates as (
    select
      d.section_id,
      d.student_id,
      count(*) as event_count,
      min(d.created_at) as window_opened_at,
      max(d.notification_reason) as latest_reason
    from public.distress_events d
    left join last_sent ls
      on ls.student_id = d.student_id and ls.section_id = d.section_id
    where d.notification_worthy = true
      and d.student_id is not null
      and d.section_id is not null
      and (ls.sent_at is null or d.created_at > ls.sent_at)
    group by d.section_id, d.student_id
  )
  select
    c.section_id,
    c.student_id,
    u.email::text,
    ss.person_email,
    c.event_count,
    c.window_opened_at,
    c.latest_reason
  from candidates c
  -- Inner join: no accepted recipient means no row, ever.
  join public.section_staff ss
    on ss.section_id = c.section_id
   and ss.role = 'escalation_recipient'
   and ss.status = 'accepted'
  join auth.users u on u.id = c.student_id
  left join last_sent ls
    on ls.student_id = c.student_id and ls.section_id = c.section_id
  where ls.sent_at is null or ls.sent_at <= now() - interval '6 hours';
$function$;


-- ============================================================================
-- run_escalation_sweep
-- ============================================================================
-- Fires the sweep endpoint. Scheduling lives here rather than in Vercel Cron
-- because the account is on Hobby, which allows one cron run per day.
--
-- The site sits behind an HTTP Basic gate that applies to API routes too, so
-- the endpoint is exempted from it in middleware and authenticated with this
-- bearer instead. That keeps the site password out of the database entirely;
-- only a purpose-made sweep secret is stored, in Vault, and it grants nothing
-- but the right to trigger a sweep.
create or replace function public.run_escalation_sweep()
returns void
language plpgsql
security definer
set search_path to 'public, extensions, vault'
as $function$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'notify_sweep_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'notify_sweep_secret';

  -- Not configured yet is a known state, not an error. Raising here would
  -- put a failure in the cron log every ten minutes until the secrets are
  -- added, which trains everyone to ignore cron failures, which is how the
  -- real one gets missed.
  if v_url is null or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$function$;


-- Mirrors the two existing purge functions: 180 days from creation.
create or replace function public.purge_notification_records()
returns void
language sql
security definer
set search_path to 'public'
as $function$
  with a as (
    delete from public.notification_deliveries
    where sent_at < now() - interval '180 days'
    returning 1
  ),
  b as (
    delete from public.notification_delivery_failures
    where created_at < now() - interval '180 days'
    returning 1
  )
  select;
$function$;


-- ============================================================================
-- RLS
-- ============================================================================
alter table public.notification_deliveries enable row level security;
alter table public.notification_delivery_failures enable row level security;

create policy "Service role full access" on public.notification_deliveries
  for all to service_role using (true) with check (true);

create policy "Service role full access" on public.notification_delivery_failures
  for all to service_role using (true) with check (true);


-- ============================================================================
-- Schedule
-- ============================================================================
-- Every ten minutes. The deduplication window is six hours, so this bounds
-- notification latency at ten minutes without any risk of duplicate sends:
-- the window, not the sweep frequency, decides how often anyone is emailed.
--
-- Hyphenated names, matching purge-distress-events and
-- purge-memory-write-failures. The two conversation-history jobs added
-- earlier tonight used underscores; that inconsistency is cosmetic and left
-- alone rather than churned.
select cron.schedule(
  'run-escalation-sweep',
  '*/10 * * * *',
  $cron$select public.run_escalation_sweep()$cron$
);

select cron.schedule(
  'purge-notification-records',
  '58 3 * * *',
  $cron$select public.purge_notification_records()$cron$
);
