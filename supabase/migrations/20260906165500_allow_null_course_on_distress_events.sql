-- Distress classification now runs independently of the entitlement check,
-- so a distress event can arrive carrying a course_id that has not been
-- validated and may not correspond to any real course.
--
-- Three options existed for that case, and two were wrong:
--   * trust the unvalidated value into the table -> a caller could write
--     arbitrary uuids into a foreign-keyed column, or fail the FK and lose
--     the event;
--   * drop the event -> a genuine crisis disclosure goes unrecorded because
--     the caller sent a bad course id, which is the worst possible reason to
--     lose a safety record.
-- So the column becomes nullable: the event is always recorded, and the
-- course association is attached only when the id resolves to a real course.
--
-- The foreign key is retained, which is what keeps the "trust it in" option
-- closed: a non-null value must still reference a real course. A null here
-- means "a distress signal we could not attribute to a course", which is
-- honest and queryable, rather than absent or fabricated.
--
-- Consequence, accepted deliberately: pattern aggregation (3 events at
-- possible_risk or above, same student, same course, 7 days) cannot include
-- null-course events, because there is no course to group by. Those events
-- still surface individually in the review tool, and interpersonal_harm
-- still bypasses the pattern requirement entirely.
alter table public.distress_events
  alter column course_id drop not null;

comment on column public.distress_events.course_id is
  'The course the event was attributed to, or null when the caller supplied a course_id that did not resolve to a real course. Nullable because distress classification runs independently of the entitlement check, so an event can arrive with an unvalidated course id; the event is always recorded and the association attached only when it validates. The FK is retained, so a non-null value always references a real course.';
