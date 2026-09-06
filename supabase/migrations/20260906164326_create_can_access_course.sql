-- Entitlement check for course content, as a database function.
--
-- WHY THIS EXISTS
--
-- match_knowledge_chunks already enforces PARTITIONING: given a course id it
-- returns that course's chunks and no others, proven under maximum pressure
-- (a foreign chunk's own embedding, a guaranteed similarity-1.0 top-rank
-- match, does not come back). But its course filter is a caller-supplied
-- PARAMETER, unlike license_confirmed / answer_bearing / assessment_scope
-- which are fixed predicates the caller cannot influence. So the function
-- guaranteed "exactly one course" and not "the course you are allowed to
-- have". Entitlement was enforced nowhere, and /api/chat read course_id
-- straight from the request body with no session check at all.
--
-- That was demonstrated live, not theorised: a second course was built with
-- deliberately unrelated content, and a caller enrolled only in MKTG365,
-- supplying a student_id with no enrollment whatsoever, received a complete
-- grounded answer from the other course purely by naming its id.
--
-- This is the missing half. It belongs in the database, not in a route-level
-- if, for the same reason answer_bearing and assessment_scope do: a
-- guarantee that lives in SQL holds for every call site that exists now or
-- later, while a route check is one new call site away from being forgotten.
--
-- FAIL CLOSED
--
-- Every path that is not an explicit allow returns false: unknown course,
-- null course, null identity where identity is required, expired course, and
-- access_mode = 'closed'. There is no "unknown means permitted" branch. The
-- caller must also fail closed when the function itself errors, which
-- /api/chat does with a 503 rather than proceeding.
--
-- ON THE 'public' BRANCH
--
-- 'public' is the one mode that does not require an enrollment, because that
-- is precisely what the operator declares by setting it (spec 12.2a: public
-- is reachable with no enrollment step). It is an opt-in away from the
-- 'closed' default, not a hole. No public course exists today, so this
-- branch is currently unreachable in practice; it is here so the function
-- expresses the documented model rather than silently contradicting it.
create or replace function public.can_access_course(
  p_student_email text,
  p_course_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.courses c
    where c.id = p_course_id
      -- Expiry applies to every mode, including public. Spec 6.12.2:
      -- existing students lose active access when a course expires, which
      -- was previously enforced nowhere at chat time.
      and (c.expires_at is null or c.expires_at > now())
      and (
        c.access_mode = 'public'
        or (
          -- Every other mode requires a verified identity AND a real
          -- enrollment row linking it to THIS course. 'closed' matches
          -- neither branch and is therefore always denied.
          c.access_mode in ('join_code', 'institutional')
          and p_student_email is not null
          and exists (
            select 1
            from public.enrollments e
            where e.course_id = c.id
              and e.student_email = p_student_email
          )
        )
      )
  );
$$;

comment on function public.can_access_course is
  'Entitlement check for course content: true only when the course exists, has not expired, and either is access_mode=public or has an enrollments row linking the supplied verified email to it. Fails closed on every other path including unknown course, null identity, and access_mode=closed. The email must come from a verified session, never from a request body.';

revoke all on function public.can_access_course(text, uuid) from public, anon, authenticated;
grant execute on function public.can_access_course(text, uuid) to service_role;

-- Branch coverage verified on application against temporary fixtures, all
-- seven as expected:
--   enrolled + join_code          -> true
--   unenrolled                    -> false
--   null identity                 -> false
--   fabricated course id          -> false
--   public + null identity        -> true
--   access_mode 'closed'          -> false
--   enrolled but course expired   -> false
