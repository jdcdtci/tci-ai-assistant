-- Structural guarantee for "create an enrollment, or return the existing
-- one if this student is already enrolled in this course": without this,
-- a check-then-insert in application code has a race window under
-- concurrent submission (double-click, retry) that could create duplicate
-- enrollment rows for the same student and course. Postgres unique
-- constraints treat NULL as distinct from other NULLs, so this still
-- permits unlimited anonymous enrollments (student_email null) per course;
-- it only enforces one row per actual (student_email, course_id) pair.
alter table enrollments
  add constraint enrollments_student_course_unique unique (student_email, course_id);
