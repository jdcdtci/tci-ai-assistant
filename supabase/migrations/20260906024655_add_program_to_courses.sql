-- Adds the program dimension to courses.
--
-- WHAT THIS COLUMN IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR
--
-- Spec 2.3 makes persona a per-program layer: ACI is a warm practitioner
-- voice, AIE a graduate-peer voice, TCI a collegial-academic voice. Until
-- now there was no program dimension anywhere in this system, so there was
-- nowhere for that to live and the assistant had a single hardcoded global
-- voice. This column is that dimension.
--
-- As of this migration, `program` is read by exactly one thing: persona
-- (voice and register) selection in lib/persona.ts. It is NOT read by any
-- guardrail, capability, refusal, integrity, privacy, or access-control
-- logic, and nothing in this migration or the code accompanying it binds a
-- guardrail tier to it.
--
-- That separation is the point, not an accident of sequencing. Spec 2.3:
-- "Keeping persona strictly cosmetic prevents a warm ACI tone from
-- accidentally loosening a for-credit integrity rule, which is a real risk
-- if persona and guardrails are entangled." A future stage that binds the
-- guardrail tier (spec 2.4) to this same column is expected and correct,
-- but it is a separate, deliberate piece of work with its own review. Until
-- that work happens, treat any code that reads `program` for a
-- non-cosmetic decision as a bug.
--
-- NOT NULL with no default, on purpose. Every other structural choice in
-- this project prefers a guarantee over a remembered convention. A default
-- here would mean a course silently inherits some program's identity
-- without anyone choosing it, which is harmless while this column only
-- drives tone but becomes actively dangerous the moment guardrail tier
-- binds to it: spec 2.4 requires a for-credit course to inherit the
-- strictest tier "without anyone remembering to set it," and a defaulted
-- or null program is exactly how that guarantee would fail quietly.
-- Forcing an explicit choice at course creation now means that later
-- binding inherits a correct value rather than a convenient one.

-- Added nullable first so the existing row can be backfilled before the
-- NOT NULL constraint is enforced.
alter table public.courses
  add column if not exists program text;

comment on column public.courses.program is
  'Which product surface this course belongs to: aci, aie, or tci. Drives persona (voice/register) selection only -- see lib/persona.ts. Deliberately NOT bound to guardrail tier as of this migration; see the migration file for why that separation is load-bearing.';

-- Backfill before enforcing NOT NULL. MKTG365 is TCI University Online
-- (the for-credit business catalog), confirmed explicitly by the project
-- owner rather than inferred from the course code. Corroborated by the
-- course source document, whose header reads "La Sierra University / Tom
-- and Vi Zapara School of Business / MKTG 365 Marketing Research", and by
-- the spec, which defines TCI University Online as for-credit degree
-- courses licensed to universities and names La Sierra as exactly that
-- licensing relationship. Recorded here so this affiliation lives in the
-- database rather than only in a conversation.
update public.courses
  set program = 'tci'
  where name = 'MKTG365' and program is null;

-- Any course row still lacking a program at this point would be one this
-- migration did not anticipate; fail loudly rather than defaulting it.
do $$
declare
  unassigned int;
begin
  select count(*) into unassigned from public.courses where program is null;
  if unassigned > 0 then
    raise exception
      'Cannot enforce courses.program NOT NULL: % course row(s) have no program assigned. Assign each one explicitly rather than defaulting it.',
      unassigned;
  end if;
end $$;

alter table public.courses
  alter column program set not null;

-- Lowercase short codes, matching the existing access_mode convention on
-- this same table. Constrained rather than free text so a typo cannot
-- silently produce a course with no matching persona (and, later, no
-- matching guardrail tier).
alter table public.courses
  drop constraint if exists courses_program_check;

alter table public.courses
  add constraint courses_program_check
  check (program in ('aci', 'aie', 'tci'));
