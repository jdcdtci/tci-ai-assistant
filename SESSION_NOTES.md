# Session Notes

Last updated: 2026-08-31. This project spans many sessions over days, not one
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
- **Real secret exposure during local debugging, and what came out of it
  (2026-08-31).** A local `cat`/`cat -A` command run to inspect
  `.env.local`'s structure printed the file's actual plaintext values
  (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SITE_PASSWORD`) into a tool-output transcript. All four were treated as
  compromised and rotated. Separately, a first attempt at generating a new
  Supabase secret key was *also* exposed, because it was pasted in
  `KEY:VALUE` label format rather than `KEY=VALUE`, defeating a redaction
  pattern that only masked content after `=`. Lesson for any future
  `.env.local` inspection in this project: check structure via name-only
  extraction and line *lengths*, never raw content -- `grep -o
  "^[A-Z_]*="`, `awk '{print NR": "length($0)}'`, never `cat`/`cat -A`/
  `sed` patterns that assume a specific separator character.
  Separately, `.env.local` was repeatedly and silently corrupted mid-session
  by a stale editor window (almost certainly TextEdit) that had the file
  open from earlier in the session and overwrote it with an outdated
  in-memory buffer on every save, regardless of what was actually being
  edited at the time -- erasing unrelated recent additions each time.
  Close any existing editor windows for `.env.local` before reopening it
  partway through a long session; a single stale window undid several
  rounds of otherwise-correct edits before this was diagnosed.
  Three real fixes came out of this, all committed together
  (`64a7b7a`):
  - **A temporary whole-site password gate** (`middleware.ts`, HTTP Basic
    Auth, gated on `SITE_PASSWORD`) in front of every route including API
    routes, for testing only -- not a replacement for the per-course
    `access_mode` system. No-op if `SITE_PASSWORD` is unset. Verified: a
    direct `POST /api/chat` with a fully valid payload is blocked before
    the route runs, without the correct password.
  - **Migrated off the legacy Supabase `service_role` key to the newer
    secret key format** (`sb_secret_...`, `SUPABASE_SECRET_KEY`), because
    `service_role` turned out to be impossible to rotate individually --
    it's a long-lived JWT tied to the whole project's shared JWT secret,
    confirmed via Supabase's current docs. The new key has the same
    effective RLS-bypass permissions, confirmed via Supabase's docs and a
    direct live test (RLS-gated table read plus the
    `match_knowledge_chunks` RPC). `SUPABASE_SERVICE_ROLE_KEY` is no
    longer referenced anywhere in code (`lib/supabase.ts` was the only
    reference) but the env var itself hasn't been deleted from
    `.env.local` or Vercel yet -- safe cleanup candidate once confirmed
    nothing else depends on it.
  - **Fixed `/api/chat`'s Anthropic client for the newly-rotated
    `ANTHROPIC_API_KEY`**, which turned out to be a personal key not
    scoped to a single workspace, requiring an `anthropic-workspace-id`
    header on every request (confirmed via Anthropic's current docs).
    Sent via `defaultHeaders` only when `ANTHROPIC_WORKSPACE_ID` is
    configured, so a differently-scoped (single-workspace) key would keep
    working unchanged with no header needed.
  All three verified together in one live request chain: password gate ->
  Supabase secret key (retrieval) -> Anthropic workspace-id header
  (completion), full real tutoring response returned successfully.

## Current state / what's NOT deployed

- **Production (`tci-ai-assistant.vercel.app`) is caught up as of this
  note** -- deployed via `vercel --prod` at the very end of this session
  (deployment `dpl_HvbjAsbp41yvWScCBwU539FEnpc9`). It now has everything:
  the full tutoring pattern and memory write path, conversation-aware
  retrieval with the relevance-gate fix, the courses/enrollments schema at
  the app level, the Google auth/join-code enrollment work, and tonight's
  password gate plus key rotation. Verified directly against the live
  domain, not assumed: unauthenticated and wrong-password requests are
  blocked (`401`) on both the homepage and a direct `POST /api/chat` with
  a fully valid payload; the correct password grants access and a real
  chat request returns a complete, correctly-grounded response, confirming
  the new Supabase secret key and the new Anthropic key plus
  workspace-id header all work together live. Treat this as a snapshot of
  that moment, not a guarantee of current state -- check `git log` against
  what's actually deployed (`vercel inspect` or a fresh `vercel --prod`)
  before assuming production still matches `main`, especially once more
  commits land after this note.
- **The whole production site, including sign-in, is now behind the
  temporary `SITE_PASSWORD` gate.** This is deliberate (see "Real secret
  exposure" above) but worth remembering if production ever looks
  "broken" to an outside visitor -- it isn't, it's gated. Removing the
  gate later just means deleting `SITE_PASSWORD` from Vercel (or emptying
  it), since the middleware no-ops when the var is unset.
- **Uncommitted locally as of this note:** nothing of substance beyond
  routine `.claude/settings.local.json` permission-allowlist drift. All
  of tonight's work (retrieval relevance gate, session notes, password
  gate, Supabase secret key migration, Anthropic workspace-id fix) is
  committed and pushed to `main`, and now deployed.
- All migrations above are already **applied directly to the live Supabase
  project** regardless of git/deploy state -- DB state and app deploy state
  are independent in this workflow.
- Required env vars (values live in `.env.local`, gitignored, never
  written to this file): `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`
  (only needed if the key isn't scoped to a single workspace -- see above),
  `VOYAGE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (replaces
  `SUPABASE_SERVICE_ROLE_KEY`, see above), `SITE_PASSWORD` (temporary
  whole-site gate, see above), `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. As of this note, Vercel's Production
  environment has the full current set, including a corrected
  `ANTHROPIC_API_KEY` (the one that had been live in Vercel was 27 days
  stale -- the pre-rotation key -- and got overwritten during this
  deploy). `SUPABASE_SERVICE_ROLE_KEY` is still present in both
  `.env.local` and Vercel but is no longer read by any code; see the
  cleanup item below. Verify with `vercel env ls production` rather than
  trusting this list indefinitely.

## In progress / next

1. ~~Finish the end-to-end enrollment test.~~ **Done.** A real
   `enrollments` row exists: `student_email = goalkeeper.dielmann@gmail.com`,
   `course_id = cbd8d7e2-b787-446e-9bce-aac386dfaaae` (MKTG365), created
   via the actual join-code screen with join code `A4D3KAWR`, not seeded
   directly.
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
5. Everything through tonight's key-rotation work is now deployed (see
   "Current state" above), but this remains the standing rule going
   forward: deploying anything new is a deliberate, manual `vercel --prod`
   step -- nothing goes live on its own, and auto-deploy stays off on
   purpose (see the git auto-deploy entry above).
6. **Clean up `SUPABASE_SERVICE_ROLE_KEY`.** No longer referenced in code
   as of tonight's secret-key migration, but the env var itself is still
   sitting in both `.env.local` and Vercel. Safe to remove once confirmed
   nothing else in the project (scripts, other tooling) still reads it.
