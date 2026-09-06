-- Durable record of a memory write that did not happen.
--
-- WHY A TABLE AND NOT A BETTER LOG LINE
--
-- The failure this records is precisely "no row was created", so a marker
-- column on student_interaction_history would be useless: there is no row to
-- mark. It needs its own record.
--
-- It also cannot be a log line. recordExchange runs inside after(), which is
-- the easiest place in this stack to lose output: locally it reaches a TTY
-- that survives only while a window stays open, and on Vercel a log drain
-- nobody reads. This session established that failure mode by accident, when
-- answering "did the memory write silently skip?" depended on a terminal
-- window still being open with enough scrollback. Had it been closed, the
-- question would have been permanently unanswerable.
--
-- Same category of fix as the distress classifier's forced-failure logging
-- and escalation_enabled being derived rather than set: the answer to "did
-- this silently fail" belongs in data that can be queried later, not in
-- output that depends on someone watching at the right moment.
--
-- WHAT IT DELIBERATELY DOES NOT STORE
--
-- No message content. The point is to know a write was lost, not to
-- reconstruct it, and student_interaction_history itself stores only a
-- concept rather than raw text. `detail` holds a system error string, never
-- anything the student wrote, and is truncated at 500 characters.
create table if not exists public.memory_write_failures (
  id uuid primary key default gen_random_uuid(),

  -- The memory path only runs for an identified student, so unlike
  -- distress_events this is never null.
  student_id uuid not null,

  course_id uuid not null references public.courses(id) on delete restrict,

  reason text not null check (reason in ('classifier_returned_null', 'exception', 'insert_failed')),

  detail text,

  created_at timestamptz not null default now()
);

comment on table public.memory_write_failures is
  'Durable record of interaction-history writes that did not happen. Exists because the failure is the ABSENCE of a row, which no marker column could express, and because recordExchange runs inside after() where log output is routinely lost. Stores no message content.';

create index if not exists memory_write_failures_created_at_idx
  on public.memory_write_failures (created_at desc);

create index if not exists memory_write_failures_student_idx
  on public.memory_write_failures (student_id, course_id, created_at desc);

alter table public.memory_write_failures enable row level security;

create policy "Service role full access"
  on public.memory_write_failures
  for all
  to service_role
  using (true)
  with check (true);

-- Bounded like everything else, and enforced rather than intended. Holds no
-- student content, so the aggressive 30-day message purge that
-- distress_events needs does not apply; 180 days matches the metadata tier
-- there.
create or replace function public.purge_memory_write_failures()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.memory_write_failures
  where created_at < now() - interval '180 days';
$$;

-- Scheduled once against the live project:
--   select cron.schedule('purge-memory-write-failures', '31 3 * * *',
--                        $$select public.purge_memory_write_failures()$$);
-- Confirmed present and active in cron.job (two active jobs total, alongside
-- purge-distress-events).
