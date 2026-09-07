-- Student-facing chat history: multi-thread verbatim transcripts, readable
-- for the duration of a student's ACTIVE section.
--
-- This migration is purely additive. It creates three tables, three
-- functions, one trigger and two cron jobs. It performs no ALTER, no DROP,
-- no backfill and no data migration, and it changes no existing table,
-- function, policy or trigger. Reverting it returns the database to exactly
-- its prior state. Contrast the sections migration, which had to re-point
-- enrollments.course_id; nothing here touches an existing row.
--
-- ============================================================================
-- THE REDACTION RULE, AND WHY IT IS ENFORCED HERE RATHER THAN IN THE ROUTE
-- ============================================================================
--
-- Any turn ever classified at personal_distress or above, OR carrying
-- interpersonal_harm, on EITHER side of the exchange, is never stored in
-- public.messages at all. Only a marker row is written. The real content
-- lives exclusively in distress_events under its own retention clock.
--
-- The predicate covers the assistant's own crisis-response text, not just
-- the student's message: the fixed crisis text itself reveals that a crisis
-- occurred, so storing it here would defeat the rule while appearing to
-- honour it.
--
-- If the text is not in the table, no query, no export bug and no future
-- call site can leak it, and it is never duplicated under two clocks. That
-- is why the CHECK constraints below make a redacted row that still carries
-- content structurally impossible rather than merely discouraged.


-- ============================================================================
-- conversations
-- ============================================================================
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),

  section_id uuid not null references public.sections(id) on delete restrict,

  -- NOT NULL is the structural guarantee that the anonymous path never
  -- persists here. An anonymous caller has no student_id, so it cannot
  -- create a conversation, cannot own one, and cannot read one. Anonymous
  -- chat continues to work exactly as it does today, entirely in browser
  -- memory, unchanged by this migration. That is enforced by this column
  -- rather than by an application check that could be forgotten.
  student_id uuid not null,

  -- Nullable until the first exchange completes and a title is derived.
  -- See force_placeholder_title_when_first_turn_redacted below: a title is
  -- only ever derived from rows in public.messages, and redacted content is
  -- never in public.messages, so a distress turn cannot reach this column.
  title text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The sidebar list: this student's conversations in this section, newest
-- activity first.
create index if not exists conversations_student_section_updated_idx
  on public.conversations (student_id, section_id, updated_at desc);


-- ============================================================================
-- messages
-- ============================================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),

  conversation_id uuid not null references public.conversations(id) on delete cascade,

  role text not null check (role in ('user', 'assistant')),

  -- NULL exactly when this row is a redaction marker. Never an empty string
  -- standing in for absent content: the CHECK below makes the two states
  -- mutually exclusive so "is this turn stored?" has one unambiguous answer.
  content text,

  created_at timestamptz not null default now(),

  redacted_at timestamptz,

  -- Deliberately constrained to ONE value.
  --
  -- The obvious temptation is to record WHY a turn was withheld, which in
  -- practice means recording its distress level. That was considered and
  -- explicitly rejected by the owner: a level recorded here would put
  -- distress metadata in a table with a 30-day delete clock while the same
  -- fact lives in distress_events under a different one, recreating the
  -- two-tables-with-different-clocks problem this project has spent
  -- considerable effort closing elsewhere.
  --
  -- The marker is therefore uniform. A withheld personal_distress turn and a
  -- withheld crisis turn are indistinguishable in this table. Nothing here
  -- can be used to reconstruct a level, because the CHECK permits no other
  -- string to be written, now or by any future call site.
  redaction_reason text check (redaction_reason is null or redaction_reason = 'withheld_by_policy'),

  -- A stored turn has content and no redaction. A redacted turn has a
  -- redaction and no content. There is no third state.
  constraint messages_content_xor_redaction
    check ((content is null) = (redacted_at is not null)),

  -- The marker's two fields move together, so a redacted row can never be
  -- written without its reason or vice versa.
  constraint messages_redaction_fields_together
    check ((redacted_at is null) = (redaction_reason is null))
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);


-- ============================================================================
-- history_write_failures
-- ============================================================================
--
-- Same pattern as memory_write_failures, for the same reason: the failure
-- being recorded is "no row was created", so there is no row to mark, and a
-- log line inside after() is the easiest output in this stack to lose.
--
-- A transcript that silently drops a turn is worse than a memory write that
-- silently drops a concept, because the student can SEE the transcript and
-- will believe it complete. This makes a lost turn queryable.
create table if not exists public.history_write_failures (
  id uuid primary key default gen_random_uuid(),

  student_id uuid not null,

  section_id uuid not null references public.sections(id) on delete restrict,

  -- ON DELETE SET NULL, not RESTRICT.
  --
  -- This differs from every other FK in the schema on purpose. Conversations
  -- are deleted at section close + 30 days while these failure rows are kept
  -- for 180, so a RESTRICT here would make the purge fail permanently the
  -- first time any conversation with a recorded failure came due. The
  -- diagnostic value of knowing WHICH conversation lost a turn expires long
  -- before the row does.
  conversation_id uuid references public.conversations(id) on delete set null,

  role text not null check (role in ('user', 'assistant')),

  reason text not null check (reason in ('insert_failed', 'exception', 'missing_conversation')),

  -- A system error string, never anything the student wrote. Truncated by
  -- the caller, exactly as memory_write_failures.detail is.
  detail text,

  created_at timestamptz not null default now()
);

create index if not exists history_write_failures_created_idx
  on public.history_write_failures (created_at);


-- ============================================================================
-- crisis_already_raised
-- ============================================================================
--
-- Replaces text-matching against conversation history for the purpose of
-- deciding whether a crisis response is a first or a repeat.
--
-- WHY THE TEXT MATCH CANNOT SURVIVE THIS FEATURE
--
-- hasCrisisAlreadyBeenRaised() in lib/distress-response.ts detects a prior
-- crisis by matching the crisis texts themselves against conversation
-- history. That works only while history is whatever the browser holds in
-- memory. Once a transcript is restored from public.messages it has HOLES
-- exactly where distress turns were, because those turns were never stored.
-- The crisis text is the one thing guaranteed absent, so the match would
-- return false and a repeat crisis in a resumed conversation would receive
-- the full script again. That is a regression against behaviour verified
-- live on 2026-09-07 (repeat=false then repeat=true in the server log).
--
-- WHY NOT A FLAG ON messages
--
-- Because that is the crisis bit rejected above. The fact belongs in
-- distress_events, which already holds it, under the clock that already
-- governs it.
--
-- ANONYMOUS CALLERS
--
-- p_student_id is null for an anonymous caller. The explicit null guard
-- makes this return false by construction rather than by relying on the
-- NULL-comparison semantics of the equality below. Anonymous callers keep
-- the existing history-based check in application code, which is correct for
-- them: they persist nothing here, so there is nothing to read back.
--
-- SURVIVES PURGING
--
-- Keys on d.level, never on d.message. purge_distress_events nulls the
-- message at section close + 30 days but keeps the row until 180, so this
-- check keeps working across the message purge.
create or replace function public.crisis_already_raised(
  p_student_id uuid,
  p_section_id uuid,
  p_since timestamptz default null
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.distress_events d
    where p_student_id is not null
      and p_section_id is not null
      and d.student_id = p_student_id
      and d.section_id = p_section_id
      and d.level = 'crisis'
      and (p_since is null or d.created_at >= p_since)
  );
$function$;


-- ============================================================================
-- force_placeholder_title_when_first_turn_redacted
-- ============================================================================
--
-- Finding 2, enforced structurally rather than by instruction.
--
-- A conversation whose opening message was distress-classified must not
-- carry a title derived from that content. A generated title would put a
-- summary of a crisis disclosure into a column under the 30-day delete
-- clock, rendered in a sidebar, outside distress_events entirely.
--
-- Two mechanisms, deliberately belt and braces. First, titles are derived
-- only from rows in public.messages, and redacted content is never there, so
-- there is nothing to derive from. Second, this trigger: if the first turn
-- of the conversation is a redaction marker, the title is forced to the
-- placeholder no matter what was submitted. The second exists because the
-- first is a property of application code, and this project's standing rule
-- is that safety guarantees live in the database.
create or replace function public.force_placeholder_title_when_first_turn_redacted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_first_redacted boolean;
begin
  if new.title is null then
    return new;
  end if;

  select (m.redacted_at is not null)
    into v_first_redacted
  from public.messages m
  where m.conversation_id = new.id
  order by m.created_at, m.id
  limit 1;

  if coalesce(v_first_redacted, false) then
    new.title := 'Conversation';
  end if;

  return new;
end;
$function$;

drop trigger if exists conversations_placeholder_title_when_redacted on public.conversations;
create trigger conversations_placeholder_title_when_redacted
  before insert or update of title on public.conversations
  for each row
  execute function public.force_placeholder_title_when_first_turn_redacted();


-- ============================================================================
-- purge_conversation_history
-- ============================================================================
--
-- The interim delete-only purge. Section close + 30 days, no export
-- involved, because the export mechanism that will eventually replace this
-- does not exist. Without it, raw student text would accumulate with no
-- deletion path at all.
--
-- Deletes conversations; messages follow by ON DELETE CASCADE.
--
-- ends_at IS NULL starts no clock and retains indefinitely. That matches
-- purge_distress_events and is a deliberate, visible state rather than a
-- silent default: sections_needing_attention already reports it as
-- no_end_date_no_purge_clock. The section live today has a null ends_at.
--
-- No section_id IS NULL fallback is needed here, unlike purge_distress_events,
-- because conversations.section_id is NOT NULL.
create or replace function public.purge_conversation_history()
returns void
language sql
security definer
set search_path to 'public'
as $function$
  delete from public.conversations c
  where exists (
    select 1
    from public.sections s
    where s.id = c.section_id
      and s.ends_at is not null
      and s.ends_at < now() - interval '30 days'
  );
$function$;


-- Mirrors purge_memory_write_failures exactly: 180 days from creation.
create or replace function public.purge_history_write_failures()
returns void
language sql
security definer
set search_path to 'public'
as $function$
  delete from public.history_write_failures
  where created_at < now() - interval '180 days';
$function$;


-- ============================================================================
-- RLS
-- ============================================================================
--
-- Same shape as every other table in this schema: RLS on, one service_role
-- policy, nothing for anon or authenticated. The browser never reads these
-- tables directly. Every read goes through the route and is gated by
-- can_access_section, which already returns false once ends_at has passed,
-- so a student loses access to their own transcripts at section close
-- without any new predicate being written.
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.history_write_failures enable row level security;

create policy "Service role full access" on public.conversations
  for all to service_role using (true) with check (true);

create policy "Service role full access" on public.messages
  for all to service_role using (true) with check (true);

create policy "Service role full access" on public.history_write_failures
  for all to service_role using (true) with check (true);


-- ============================================================================
-- Scheduled purges
-- ============================================================================
-- Placed after the two existing jobs (03:17, 03:31) rather than alongside
-- them, so a slow purge cannot overlap the ones already proven.
select cron.schedule(
  'purge_conversation_history',
  '45 3 * * *',
  $cron$select public.purge_conversation_history()$cron$
);

select cron.schedule(
  'purge_history_write_failures',
  '52 3 * * *',
  $cron$select public.purge_history_write_failures()$cron$
);
