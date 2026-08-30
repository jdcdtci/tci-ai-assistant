# Session Notes

Last updated: 2026-08-30. This project spans many sessions over days, not one
sitting. This file exists so a fresh session (or a future you with a fresh
context window) can pick up accurately without re-deriving decisions already
made. Treat it as a snapshot, not a live source of truth — always verify
against `git status`, `git log`, and the actual Supabase project before
acting on anything stated here.

There are two unrelated "Step N" numbering schemes used in commit history
and prior conversation — don't conflate them:
- **Memory-system steps** (schema -> retrieval -> conversation-aware
  retrieval) for the tutoring/RAG assistant itself.
- **Enrollment-system steps** (Step 1 = courses/enrollments schema, Step 2 =
  Google auth + join-code enrollment) for course access control, built
  later and separately.

## What's built and verified

### Course knowledge / RAG (tutoring assistant)
- `knowledge_documents` / `knowledge_chunks`: source docs and embedded
  chunks (Voyage `voyage-3-large`, 1024 dims). One real course ingested:
  MKTG365 (240 chunks, `license_confirmed = true`).
- `match_knowledge_chunks`: pgvector cosine-similarity search function.
  Excludes chunks where `answer_bearing = true` and where the parent
  document's `license_confirmed = false` -- both enforced in the DB
  function itself, not application code.
- `/api/chat`: retrieval-augmented, conversation-aware. Before embedding,
  `isFollowUpOnTopic()` (a fast Claude call, only run when there's history)
  decides whether the new message actually continues the recent
  conversation; only then does recent context get folded into the
  retrieval query, otherwise the new message is embedded alone -- see
  "Retrieval contamination bug" below. Full diagnose/explain/check/adapt
  tutoring pattern with an optional acknowledgment step and non-forced
  follow-up checks. Rate-limited per caller (Upstash) and separately
  queues/backs off on Voyage's account-wide free-tier limit (3 req/min,
  10K tokens/min) so
  contention delays a response rather than failing it (~up to a couple
  minutes worst case, confirmed under real concurrent load). UI shows a
  "still working" message past 8s so this doesn't look frozen.
- `student_interaction_history`: working memory of what a student has
  discussed and whether comprehension checks landed. Populated by an LLM
  classifier (`lib/classify.ts`) after each response (via `after()`, so it
  never delays the student's answer). Documented rule: a verdict is
  recorded whenever the student's reply gives real evidence of
  understanding, whether from an explicit check or volunteered on their
  own; declining/ignoring an offered check resolves as `null` (no
  evidence), not a failure.
- Not yet wired: retrieval doesn't read from `student_interaction_history`
  at all yet (no Step where past struggle/mastery informs what gets
  retrieved or how the assistant responds). Every table added so far has
  RLS enabled, default-deny for `anon`/`authenticated`, one explicit
  `service_role`-only policy -- verified per-table via `pg_policies`, not
  just assumed. Keep doing this for any new table.

### Course access control (join-code enrollment)
- `courses`: id, name, `join_code` (unique, auto-generated -- see below),
  `expires_at`, `access_mode` (`public` / `join_code` / `institutional`,
  default `public`), `escalation_enabled` + `escalation_recipient_email`
  with a DB-level CHECK that escalation cannot be enabled without a
  recipient set.
- `enrollments`: `student_email` (null = anonymous), `course_id`, unique on
  `(student_email, course_id)` so "create or return existing enrollment" is
  structurally race-safe, not just usually-correct application logic.
- `generate_unique_join_code()`: Postgres function, set as `join_code`'s
  column DEFAULT. Any insert into `courses` that doesn't specify its own
  `join_code` gets one automatically -- 8 chars, safe alphabet (no
  `0/O/1/I/L`), collision-proofed by a retry loop against the unique
  constraint. Verified working live.
- Google sign-in via Supabase Auth (`@supabase/ssr`): browser + server
  clients, `middleware.ts` (required to keep the session cookie fresh --
  Next.js 16 deprecated the `middleware.ts` filename in favor of
  `proxy.ts`; still works, harmless warning, not yet renamed),
  `app/auth/callback/route.ts` exchanges the OAuth code for a session.
  **Verified working end-to-end in the browser with a real Google
  account** (goalkeeper.dielmann@gmail.com) after two external setup steps
  were completed in Google Cloud Console + the Supabase dashboard (Google
  provider enabled, real Client ID/Secret saved, redirect URLs allowlisted).
- `POST /api/enroll`: reads the verified email server-side from the
  session (never trusts client-supplied identity), looks up the course by
  join code, checks expiry, creates the enrollment or returns the existing
  one on a `23505` unique-violation instead of erroring.
- `page.tsx` now gates on real auth state (sign-in screen -> join-code
  entry -> chat), and sends the real Supabase Auth user id as `student_id`
  to `/api/chat`, replacing the old per-browser localStorage placeholder
  UUID.
- Real test course exists: **MKTG365**, `course_id =
  cbd8d7e2-b787-446e-9bce-aac386dfaaae`, `join_code = A4D3KAWR`,
  `access_mode = 'join_code'`, no expiration. This `id` was deliberately
  set to match the `course_id` already used on all 240 ingested
  knowledge_chunks -- there is no FK between `courses` and
  `knowledge_documents.course_id` yet, so this match was manual and matters:
  a randomly-generated `courses.id` here would have enrolled students into
  a course with zero linked content.

## Key decisions and reasoning

- **`join_code` and `expires_at` are nullable.** Only `access_mode =
  'join_code'` courses need a code at all (`public`/`institutional` don't);
  Postgres unique constraints permit multiple nulls, so this doesn't weaken
  uniqueness among courses that do have one. `expires_at = null` means "no
  expiration," not an error state -- confirmed as the intended reading, not
  just my assumption.
- **`access_mode` defaults to `'public'`.** Matches the "structural
  guarantee, not app-code memory" pattern used everywhere else in this
  project: the safe/permissive default requires no explicit choice, and
  tightening access is an opt-in per course rather than opt-out.
- **`escalation_enabled` requires `escalation_recipient_email` set, enforced
  by a DB CHECK constraint**, not application code remembering to verify
  it. Prevents escalation ever being silently turned on with nowhere for it
  to go.
- **RLS is default-deny + service-role-only on every table**, even though
  `service_role` bypasses RLS by design and gets zero *additional*
  protection from this. The actual reason: Supabase auto-exposes every
  `public`-schema table over its REST API, and the `anon` key is not secret
  by design (meant to be client-embeddable). Without RLS, anyone holding
  that key could read/write these tables directly over HTTP, regardless of
  how the app itself is built. This is now a standing convention for any
  new table in this project, confirmed live via `pg_policies` each time
  (policy count, role, command), not just "I enabled RLS and moved on."
- **`answer_bearing` filtering happens in `match_knowledge_chunks` itself**,
  not in `/api/chat`. Same reasoning as RLS: a DB-layer guarantee holds
  regardless of which future code path queries chunks; an app-layer filter
  is one new call site away from being forgotten.
- **The retraction bug (found and fixed):** retrieval used to embed only
  the latest message. A student could get a correct, grounded answer, then
  ask a differently-worded follow-up that embedded away from the original
  topic, and the assistant would honestly-but-wrongly say the material
  didn't cover something it had already answered -- retracting its own
  correct prior answer. Fixed by embedding recent conversation context
  alongside the new message, plus an explicit system-prompt rule: retrieval
  gaps on a given turn are never evidence an earlier answer was wrong.
  Reproduced and reverified clean after the fix.
- **Retrieval contamination bug (found and fixed, 2026-08-30):** the
  retraction fix above had a real blind spot: folding recent context into
  every follow-up's retrieval query assumed the recent turns were still on
  topic. Live reproduction: a student asked an off-topic detour ("give me
  the python code to get into claude code") mid-conversation, then asked a
  genuine, on-topic question about problem definition -- and the assistant
  wrongly claimed the material didn't cover it, because the detour's text
  (plus an earlier "four principles" ethics tangent) dominated the
  embedding and pulled retrieval toward ethics content instead. Verified
  precisely: the isolated question alone retrieved the right chunks at
  0.51 similarity; the actual contaminated query retrieved ethics chunks
  at 0.74 similarity, none of the right material in the top 5.
  Fixed with a relevance gate (`isFollowUpOnTopic()` in
  `app/api/chat/route.ts`), not a weighting tweak: before building the
  augmented query, a dedicated Claude call judges whether the new message
  is an intentional continuation of the recent conversation or a fresh,
  unrelated question, and only includes context in the first case. The
  distinction that matters is intentional continuity, not raw topic
  similarity -- confirmed by a third test case where a follow-up
  explicitly bridged to a *different* concept ("does that same idea also
  apply to writing survey questions?") and was correctly still treated as
  a follow-up, with retrieval landing on real, verified survey-design
  material despite the topic shift. Implemented as a Claude call
  specifically instead of a second Voyage embedding: Voyage's account-wide
  rate limit (3 req/min free tier) is the actual bottleneck in this
  system, already requiring the queue/backoff machinery in `/api/chat`
  described above, and Claude has no equivalent constraint here. Verified
  against three cases: the original retraction scenario (still passes),
  this exact contamination reproduction (now correctly excludes the
  off-topic context), and the ambiguous bridging case (correctly included,
  and correctly grounded).
- **The `answer_bearing` leak (found and fixed):** assignment/activity
  prompts (scenario + required deliverable, e.g. "Activity 1-2") were
  ingested as ordinary searchable content. A general question once
  retrieved one and the assistant performed the actual assignment live in
  the response, including one exact reproduced case where it told a
  student "the correct answer is B" for a multiple-choice question the
  student never saw. Fixed by tagging all matching chunks
  `answer_bearing = true` (pattern search for `Activity \d+-\d+:` plus
  manually-identified unlabeled equivalents) and excluding them at the DB
  layer. If MKTG365 content is ever re-ingested, this tagging does not
  happen automatically -- it was a manual pass.
- **Git-based Vercel auto-deploy was found active and deliberately
  disconnected this session** (`vercel git disconnect`, confirmed via both
  the Vercel API and a real test push producing zero deployments). This
  project intentionally has no auto-deploy: `vercel --prod` is the only
  path to production, on purpose, so nothing ships without a deliberate
  step. If a future session finds auto-deploy active again, that's a
  regression, not a feature -- it was explicitly turned off for a reason.

## Current state / what's NOT deployed

- **Production (`tci-ai-assistant.vercel.app`) is several commits behind
  local.** Last manual deploy was the page-title commit; it has the full
  tutoring pattern, memory write path, and the *original* conversation-aware
  retrieval, but **not** the relevance-gate fix above -- production still
  has the retrieval contamination bug right now. Also **not** deployed: the
  courses/enrollments schema at the app level (though the DB tables exist
  -- Supabase migrations apply independently of app deploys) and **not**
  any of the Google auth/enrollment work. Confirmed directly: production's
  `/api/enroll` returns 404, and `/api/chat` still answers with zero auth
  check.
- **Uncommitted locally as of this note** (verify with `git status` before
  trusting this list): nothing of substance. The Google auth/enrollment
  work, the join-code auto-generation migration, and the retrieval
  relevance gate are all committed and pushed to `main` as of this note
  (only routine `.claude/settings.local.json` permission-allowlist drift
  is typically uncommitted at any given moment).
- All migrations above are already **applied directly to the live Supabase
  project** regardless of git/deploy state -- DB state and app deploy state
  are independent in this workflow. Git being behind does not mean the
  database is behind.
- Required env vars (values live in `.env.local`, gitignored, never
  written to this file): `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Production has its own copies set in
  Vercel (Production + Preview environments) from earlier deploys.

## In progress / next

1. **Finish the end-to-end enrollment test.** Real Google sign-in is
   verified working in the browser. Join code `A4D3KAWR` for MKTG365
   exists. Submitting that code through the actual join-code screen and
   confirming a real row lands in `enrollments` (currently 0 rows) has
   **not** happened yet -- this is the very next step.
2. **`/api/chat` still fully trusts the client-supplied `student_id`.**
   It's now sourced from the real authenticated user (good), but the route
   never verifies it server-side against the session the way `/api/enroll`
   does, and the route also doesn't check that the caller is actually
   enrolled in the `course_id` they're chatting about. Both are open
   hardening gaps, not yet decided as in-scope or out-of-scope.
3. **`student_interaction_history.student_id` migration.** Newly-written
   rows from an authenticated session now use the real Supabase Auth user
   id. Any rows written before this session's auth work used the old
   per-browser localStorage placeholder UUID and are orphaned from real
   identity -- not migrated, not deleted, just stale. Worth a decision on
   whether to purge them or leave them as pre-auth test noise.
4. Retrieval still doesn't use `student_interaction_history` at all (see
   above) -- that's a real next step for the memory system, separate from
   the enrollment work.
5. Deploying any of this to production is a deliberate separate step
   (`vercel --prod`, manually) -- nothing here goes live on its own.
