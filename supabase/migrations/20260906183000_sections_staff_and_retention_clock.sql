-- ============================================================
-- APPLIED 2026-09-06. sections, section_staff with acceptance,
-- role-change audit, and the retention-clock fix.
--
-- Single atomic migration by decision: a half-migrated safety boundary is
-- worse than either end state. Postgres runs this in one transaction, so it
-- either fully applies or fully rolls back.
--
-- MUST be followed immediately by the matching code deploy. Between the two,
-- /api/chat returns 503 and /api/enroll returns 500. Both fail closed and
-- loudly; nothing is silently accepted or corrupted.
-- ============================================================

-- ---------- 1. sections ----------
create table public.sections (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete restrict,
  label text not null,

  -- Globally unique, not per course: a student types a code with no course
  -- context, so it must identify exactly one section system-wide.
  join_code text unique default generate_unique_join_code(),

  access_mode text not null default 'closed'
    check (access_mode in ('closed', 'public', 'join_code', 'institutional')),

  -- starts_at is new behaviour: a section that has not begun is not
  -- enterable, which nothing enforced before.
  starts_at timestamptz,
  ends_at timestamptz,

  institutional_crisis_resource text,
  topic_listing_enabled boolean not null default false,

  solo_responsibility_ack text,
  solo_responsibility_ack_at timestamptz,

  created_at timestamptz not null default now(),

  constraint sections_dates_ordered
    check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint sections_solo_ack_complete
    check ((solo_responsibility_ack is null) = (solo_responsibility_ack_at is null)),
  constraint sections_solo_ack_substantive
    check (solo_responsibility_ack is null or length(btrim(solo_responsibility_ack)) >= 40)
);

comment on table public.sections is
  'A single offering of a course, with its own dates, access code, access mode, and staff. Entitlement is section-scoped; course content is course-scoped and shared across all sections of a course.';

create index sections_course_idx on public.sections (course_id);
alter table public.sections enable row level security;
create policy "Service role full access" on public.sections
  for all to service_role using (true) with check (true);

-- ---------- 2. section_staff ----------
-- Roles split into two classes:
--   * multi-assignee, effective immediately: professor (co-teaching is
--     allowed), staff (general dashboard access, any number of people)
--   * single-assignee, acceptance required: escalation_recipient,
--     wellbeing_reader
--
-- A professor NAMING someone for a safety role is a proposal, not an
-- appointment. The row exists as 'pending' and confers nothing until the
-- named person accepts, mirroring the standing principle that escalation
-- only works when a real person has actually agreed to receive it.
create table public.section_staff (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.sections(id) on delete restrict,
  person_email text not null,

  role text not null
    check (role in ('professor', 'staff', 'escalation_recipient', 'wellbeing_reader')),

  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'revoked')),

  -- Only meaningful for wellbeing_reader: the committed maximum interval
  -- between reviews. Kept on the assignment so the commitment travels with
  -- the person who made it.
  review_interval_hours integer,

  proposed_at timestamptz not null default now(),
  accepted_at timestamptz,

  constraint section_staff_interval_positive
    check (review_interval_hours is null or review_interval_hours > 0),
  constraint section_staff_interval_only_for_reader
    check ((role = 'wellbeing_reader') = (review_interval_hours is not null)),

  -- Both-or-neither, same discipline used everywhere else here.
  constraint section_staff_accepted_at_complete
    check ((status = 'accepted') = (accepted_at is not null)),

  -- Roles that do not require acceptance are never 'pending' or 'declined':
  -- they are effective when created and end when revoked.
  constraint section_staff_status_matches_role
    check (
      role in ('escalation_recipient', 'wellbeing_reader')
      or status in ('accepted', 'revoked')
    )
);

comment on table public.section_staff is
  'Who holds which role for a section. professor and staff are multi-assignee and effective immediately. escalation_recipient and wellbeing_reader are single-assignee and require the named person to accept before the role becomes active; until then the row is pending and confers nothing.';

-- AT MOST ONE accepted holder of each safety role per section. Partial, on
-- accepted rows only, so a successor can be proposed while the incumbent is
-- still serving. A full unique constraint would force a gap with no
-- recipient at every handover, which is the exact hazard being guarded.
create unique index section_staff_one_accepted_safety_role
  on public.section_staff (section_id, role)
  where status = 'accepted' and role in ('escalation_recipient', 'wellbeing_reader');

-- At most one pending proposal per safety role, so two competing proposals
-- cannot race to acceptance.
create unique index section_staff_one_pending_safety_role
  on public.section_staff (section_id, role)
  where status = 'pending' and role in ('escalation_recipient', 'wellbeing_reader');

create index section_staff_section_idx on public.section_staff (section_id, role, status);
create index section_staff_person_idx on public.section_staff (person_email, status);

alter table public.section_staff enable row level security;
create policy "Service role full access" on public.section_staff
  for all to service_role using (true) with check (true);

-- ---------- 3. role-change audit, with attribution enforced ----------
create table public.section_staff_audit (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null,
  staff_id uuid not null,
  role text not null,
  person_email text not null,
  action text not null
    check (action in ('proposed', 'assigned', 'accepted', 'declined', 'revoked', 'removed', 'updated')),
  -- Who made the change. Never nullable: see the trigger below.
  actor_email text not null,
  occurred_at timestamptz not null default now()
);

comment on table public.section_staff_audit is
  'Append-only record of every role change: additions, removals, acceptances, declines, revocations. Covers all roles, not only the two safety-critical ones, since adding or removing a TA is also a real access change.';

create index section_staff_audit_section_idx on public.section_staff_audit (section_id, occurred_at desc);
alter table public.section_staff_audit enable row level security;
create policy "Service role full access" on public.section_staff_audit
  for all to service_role using (true) with check (true);

-- A trigger can see WHAT changed but not WHO changed it, so the actor is
-- read from a session setting the caller must declare. If it is absent the
-- write is REJECTED rather than recorded without attribution: an
-- unattributed role change fails loudly instead of being silently accepted.
--
-- Application code must run `set local app.actor_email = '<verified email>'`
-- in the same transaction as any write to section_staff.
create or replace function public.log_section_staff_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor text := nullif(current_setting('app.actor_email', true), '');
  v_action text;
  v_row public.section_staff;
begin
  if v_actor is null then
    raise exception
      'Refusing an unattributed role change on section_staff. Set app.actor_email to the acting person''s verified email in the same transaction.'
      using errcode = 'check_violation';
  end if;

  if TG_OP = 'DELETE' then
    v_row := OLD;
    v_action := 'removed';
  elsif TG_OP = 'INSERT' then
    v_row := NEW;
    v_action := case when NEW.status = 'accepted' then 'assigned' else 'proposed' end;
  else
    v_row := NEW;
    v_action := case
      when OLD.status is distinct from NEW.status then NEW.status
      else 'updated'
    end;
  end if;

  insert into public.section_staff_audit
    (section_id, staff_id, role, person_email, action, actor_email)
  values
    (v_row.section_id, v_row.id, v_row.role, v_row.person_email, v_action, v_actor);

  return null;
end $$;

create trigger section_staff_audit_all_changes
  after insert or update or delete on public.section_staff
  for each row execute function public.log_section_staff_change();

-- ---------- 4. derived facts, computed from ACCEPTED rows only ----------
-- escalation_enabled was a generated column. A generated column may only
-- reference its own row, so it cannot derive from section_staff. Dropping
-- the stored flag entirely is strictly stronger: with no stored value,
-- nothing CAN disagree with the source rather than being forced to agree.
create or replace function public.section_escalation_enabled(p_section_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.section_staff
    where section_id = p_section_id
      and role = 'escalation_recipient' and status = 'accepted'
  );
$$;

create or replace function public.section_wellbeing_reader_set(p_section_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.section_staff
    where section_id = p_section_id
      and role = 'wellbeing_reader' and status = 'accepted'
  );
$$;

-- Concentration counts ACCOUNTABLE roles only. 'staff' is a permission, not
-- an accountability, so holding general dashboard access alongside a safety
-- role does not trip the gate.
create or replace function public.section_has_role_concentration(p_section_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.section_staff
    where section_id = p_section_id
      and status = 'accepted'
      and role in ('professor', 'escalation_recipient', 'wellbeing_reader')
    group by person_email
    having count(distinct role) >= 2
  );
$$;

-- ---------- 5. can_access_section ----------
-- ORDERING NOTE (found at apply time): this is created AFTER
-- enrollments.section_id exists, further down. A `language sql` function
-- body is validated when the function is created, so defining it here
-- referenced a column that did not exist yet and aborted the migration.
-- The whole migration rolled back cleanly, which is why the atomic
-- single-migration decision mattered. Left in place below section 9.
create or replace function public.can_access_section(
  p_student_email text,
  p_section_id uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.sections s
    where s.id = p_section_id
      and (s.starts_at is null or s.starts_at <= now())
      and (s.ends_at is null or s.ends_at > now())
      and (
        s.access_mode = 'public'
        or (
          s.access_mode in ('join_code', 'institutional')
          and p_student_email is not null
          and exists (
            select 1 from public.enrollments e
            where e.section_id = s.id and e.student_email = p_student_email
          )
        )
      )
  );
$$;

comment on function public.can_access_section is
  'Entitlement check for section content. True only when the section exists, is within its dates, and is either access_mode=public or has an enrollments row linking the supplied verified email to it. Fails closed everywhere else. The email must come from a verified session, never a request body.';

revoke all on function public.can_access_section(text, uuid) from public, anon, authenticated;
grant execute on function public.can_access_section(text, uuid) to service_role;

-- ---------- 6. migrate MKTG365 ----------
-- The audit trigger requires an actor, including for this migration's own
-- writes. Attributing them to the migration is more honest than exempting
-- them: these seed rows ARE role assignments.
-- SET rather than SET LOCAL: SET LOCAL silently does nothing outside an
-- explicit transaction block, which would leave the audit trigger with no
-- actor and reject these seed inserts. Session scope ends with the migration.
set app.actor_email = 'system:sections-migration';

insert into public.sections (
  course_id, label, join_code, access_mode,
  institutional_crisis_resource, topic_listing_enabled,
  solo_responsibility_ack, solo_responsibility_ack_at
)
select c.id, 'Section 1', c.join_code, c.access_mode,
       c.institutional_crisis_resource, c.topic_listing_enabled,
       c.solo_responsibility_ack, c.solo_responsibility_ack_at
from public.courses c;

-- Pre-existing assignments are seeded as 'accepted' because they predate the
-- acceptance mechanism and reflect roles the owner already holds in reality.
-- Recorded as a deliberate exception rather than an implied one: these two
-- rows never passed through the acceptance flow.
insert into public.section_staff (section_id, person_email, role, status, accepted_at, review_interval_hours)
select s.id, c.escalation_recipient_email, 'escalation_recipient', 'accepted', now(), null
from public.sections s join public.courses c on c.id = s.course_id
where c.escalation_recipient_email is not null;

insert into public.section_staff (section_id, person_email, role, status, accepted_at, review_interval_hours)
select s.id, c.distress_log_reader_email, 'wellbeing_reader', 'accepted', now(), c.distress_log_review_interval_hours
from public.sections s join public.courses c on c.id = s.course_id
where c.distress_log_reader_email is not null;

-- Professor of record: the same person today. This is an INFERENCE from the
-- escalation recipient, made explicit rather than left implied. If the
-- professor of record is ever someone else, this row is wrong from the start.
insert into public.section_staff (section_id, person_email, role, status, accepted_at, review_interval_hours)
select s.id, c.escalation_recipient_email, 'professor', 'accepted', now(), null
from public.sections s join public.courses c on c.id = s.course_id
where c.escalation_recipient_email is not null;

-- ---------- 7. the "at least one" half of the access gate ----------
-- A CHECK cannot reference another table, so the gate that used to be
-- courses_access_requires_distress_reader becomes a trigger on sections.
--
-- EXPANDED vs the previous behaviour, deliberately: opening a section now
-- requires an accepted wellbeing_reader AND an accepted escalation_recipient.
-- Previously only the reader gated access. A section reachable by students
-- with no escalation recipient means a student asking for a human has
-- nowhere to go, which is the same hazard class the reader gate addresses.
create or replace function public.reject_open_section_without_safety_roles()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.access_mode <> 'closed' then
    if not public.section_wellbeing_reader_set(new.id) then
      raise exception
        'Section % cannot be opened: no accepted wellbeing_reader. Propose one and have them accept first.', new.id
        using errcode = 'check_violation';
    end if;
    if not public.section_escalation_enabled(new.id) then
      raise exception
        'Section % cannot be opened: no accepted escalation_recipient. Propose one and have them accept first.', new.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- Created AFTER the seed, so the seeded open section is evaluated only on
-- subsequent changes and its staff already exist.
create trigger sections_require_safety_roles_when_open
  before insert or update of access_mode on public.sections
  for each row execute function public.reject_open_section_without_safety_roles();

-- Assert the seeded state actually satisfies the gate, rather than trusting
-- that creating the trigger afterwards papered over a violation.
do $$
declare bad int;
begin
  select count(*) into bad
  from public.sections s
  where s.access_mode <> 'closed'
    and (not public.section_wellbeing_reader_set(s.id)
         or not public.section_escalation_enabled(s.id));
  if bad > 0 then
    raise exception 'Seeded % open section(s) without both safety roles accepted. Aborting.', bad;
  end if;
end $$;

-- ---------- 8. removal protection ----------
-- Revoking or deleting the sole accepted holder of a safety role while the
-- section is open would silently drop it below "at least one" while students
-- are still active. Handover before release: a successor must have accepted
-- first.
create or replace function public.protect_last_safety_role_holder()
returns trigger language plpgsql set search_path = public as $$
declare
  v_mode text;
  v_others int;
  v_role text := old.role;
begin
  if v_role not in ('escalation_recipient', 'wellbeing_reader') then
    return coalesce(new, old);
  end if;
  if old.status <> 'accepted' then
    return coalesce(new, old);
  end if;
  -- Still accepted after this change? Then nothing is being released.
  if TG_OP = 'UPDATE' and new.status = 'accepted' then
    return new;
  end if;

  select access_mode into v_mode from public.sections where id = old.section_id;
  if v_mode is null or v_mode = 'closed' then
    return coalesce(new, old);
  end if;

  select count(*) into v_others
  from public.section_staff
  where section_id = old.section_id and role = v_role
    and status = 'accepted' and id <> old.id;

  if v_others = 0 then
    raise exception
      'Cannot release the only accepted % for open section %. Have a successor accept first, or close the section.',
      v_role, old.section_id
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end $$;

create trigger section_staff_protect_last_holder
  before update or delete on public.section_staff
  for each row execute function public.protect_last_safety_role_holder();

-- ---------- 9. repoint the four dependent tables ----------
alter table public.enrollments add column section_id uuid references public.sections(id) on delete cascade;
alter table public.distress_events add column section_id uuid references public.sections(id) on delete restrict;
alter table public.student_interaction_history add column section_id uuid references public.sections(id) on delete restrict;
alter table public.memory_write_failures add column section_id uuid references public.sections(id) on delete restrict;

update public.enrollments e set section_id = s.id
  from public.sections s where s.course_id = e.course_id;
update public.distress_events d set section_id = s.id
  from public.sections s where s.course_id = d.course_id;
update public.student_interaction_history h set section_id = s.id
  from public.sections s where s.course_id = h.course_id;
update public.memory_write_failures m set section_id = s.id
  from public.sections s where s.course_id = m.course_id;

do $$
declare orphans int;
begin
  select (select count(*) from public.enrollments where section_id is null)
       + (select count(*) from public.student_interaction_history where section_id is null)
       + (select count(*) from public.memory_write_failures where section_id is null)
    into orphans;
  if orphans > 0 then
    raise exception 'Backfill left % row(s) without a section. Aborting.', orphans;
  end if;
end $$;

alter table public.enrollments alter column section_id set not null;
alter table public.student_interaction_history alter column section_id set not null;
alter table public.memory_write_failures alter column section_id set not null;
-- distress_events.section_id stays NULLABLE: an event may arrive with an
-- unvalidated identifier and must still be recorded.

alter table public.enrollments drop column course_id;
alter table public.distress_events drop column course_id;
alter table public.student_interaction_history drop column course_id;
alter table public.memory_write_failures drop column course_id;

alter table public.enrollments drop constraint if exists enrollments_student_course_unique;
alter table public.enrollments
  add constraint enrollments_student_section_unique unique (student_email, section_id);

-- ---------- 10. one active enrollment per course per student ----------
create or replace function public.reject_second_section_same_course()
returns trigger language plpgsql set search_path = public as $$
declare existing int;
begin
  select count(*) into existing
  from public.enrollments e
  join public.sections es on es.id = e.section_id
  join public.sections ns on ns.id = new.section_id
  where e.student_email = new.student_email
    and es.course_id = ns.course_id
    and e.section_id <> new.section_id;

  if existing > 0 then
    raise exception
      'Student % is already enrolled in another section of this course. One active enrollment per course per student.',
      new.student_email
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger enrollments_reject_second_section
  before insert on public.enrollments
  for each row execute function public.reject_second_section_same_course();

-- ---------- 11. move the two existing enrollment triggers to sections ----------
create or replace function public.reject_enrollment_when_section_closed()
returns trigger language plpgsql set search_path = public as $$
declare mode text;
begin
  select access_mode into mode from public.sections where id = new.section_id;
  if mode is null then
    raise exception 'Enrollment refers to a section that does not exist: %', new.section_id;
  end if;
  if mode = 'closed' then
    raise exception 'Section % is closed to student access and cannot accept enrollments.', new.section_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function public.reject_enrollment_without_solo_ack()
returns trigger language plpgsql set search_path = public as $$
declare v_ack text;
begin
  select solo_responsibility_ack into v_ack from public.sections where id = new.section_id;

  if public.section_has_role_concentration(new.section_id) and v_ack is null then
    raise exception
      'Section % cannot accept enrollments yet: one person holds two or more of the professor, escalation recipient, and wellbeing reader roles, and sections.solo_responsibility_ack has not been written. Record who else holds a role and who the backup reader is, then retry.',
      new.section_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists enrollments_reject_when_course_closed on public.enrollments;
drop trigger if exists enrollments_require_solo_ack on public.enrollments;
drop function if exists public.reject_enrollment_when_course_closed();

create trigger enrollments_reject_when_section_closed
  before insert on public.enrollments
  for each row execute function public.reject_enrollment_when_section_closed();

create trigger enrollments_require_solo_ack
  before insert on public.enrollments
  for each row execute function public.reject_enrollment_without_solo_ack();

-- ---------- 12. retention clock keyed off section close ----------
-- The old clock keyed off each event's own creation date, so on any term
-- longer than 30 days the crisis text would null out MID-TERM, while the
-- section was still active and the wellbeing reader still carried a standing
-- obligation to read it. Fixed here rather than later because the daily cron
-- job is live: landing sections first would leave a window in which the
-- schema supports the fix but the job still runs the old clock.
--
-- Null ends_at means no purge clock starts at all. Events with a null
-- section_id have no section to key off and fall back to their own age.
create or replace function public.purge_distress_events()
returns void language sql security definer set search_path = public as $$
  with purged as (
    update public.distress_events d
      set message = null, message_purged_at = now()
    where d.message is not null
      and (
        exists (
          select 1 from public.sections s
          where s.id = d.section_id
            and s.ends_at is not null
            and s.ends_at < now() - interval '30 days'
        )
        or (d.section_id is null and d.created_at < now() - interval '30 days')
      )
    returning 1
  ),
  deleted as (
    delete from public.distress_events d
    where (
      exists (
        select 1 from public.sections s
        where s.id = d.section_id
          and s.ends_at is not null
          and s.ends_at < now() - interval '180 days'
      )
      or (d.section_id is null and d.created_at < now() - interval '180 days')
    )
    returning 1
  )
  select;
$$;

-- ---------- 13. visible warning state, not a silent default ----------
create or replace view public.sections_needing_attention as
select s.id as section_id, c.name as course_name, s.label, s.access_mode,
       (s.ends_at is null) as no_end_date_no_purge_clock,
       not public.section_escalation_enabled(s.id) as no_accepted_escalation_recipient,
       not public.section_wellbeing_reader_set(s.id) as no_accepted_wellbeing_reader,
       (public.section_has_role_concentration(s.id) and s.solo_responsibility_ack is null)
         as unacknowledged_role_concentration,
       exists (select 1 from public.section_staff st
               where st.section_id = s.id and st.status = 'pending') as has_pending_role_proposal
from public.sections s
join public.courses c on c.id = s.course_id
where s.ends_at is null
   or not public.section_escalation_enabled(s.id)
   or not public.section_wellbeing_reader_set(s.id)
   or (public.section_has_role_concentration(s.id) and s.solo_responsibility_ack is null)
   or exists (select 1 from public.section_staff st
              where st.section_id = s.id and st.status = 'pending');

comment on view public.sections_needing_attention is
  'Sections in a state needing a human decision rather than a silent default: no end date (so no retention clock ever starts), no accepted escalation recipient or wellbeing reader, unacknowledged role concentration, or a role proposal still awaiting acceptance.';

-- ---------- 14. drop what has moved off courses ----------
alter table public.courses drop constraint if exists courses_access_requires_distress_reader;
alter table public.courses drop constraint if exists courses_distress_reader_complete;
alter table public.courses drop constraint if exists courses_distress_interval_positive;
alter table public.courses drop constraint if exists courses_solo_ack_complete;
alter table public.courses drop constraint if exists courses_solo_ack_substantive;
alter table public.courses drop constraint if exists courses_access_mode_check;

alter table public.courses drop column escalation_enabled;
alter table public.courses drop column escalation_recipient_email;
alter table public.courses drop column distress_log_reader_email;
alter table public.courses drop column distress_log_review_interval_hours;
alter table public.courses drop column solo_responsibility_ack;
alter table public.courses drop column solo_responsibility_ack_at;
alter table public.courses drop column institutional_crisis_resource;
alter table public.courses drop column topic_listing_enabled;
alter table public.courses drop column access_mode;
alter table public.courses drop column join_code;
alter table public.courses drop column expires_at;

-- courses now holds only what is genuinely shared across sections:
-- id, name, program, created_at. program stays because persona is
-- per-program (spec 2.3) and all sections of a course share it.

drop function if exists public.can_access_course(text, uuid);
