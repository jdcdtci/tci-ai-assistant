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

> **Superseded as of 2026-09-05.** The ordering below reflects the state
> before Phase 3 was planned and paused. The authoritative current priority
> order is the four-stage sequence in "2026-09-05" at the end of this file.
> The items below remain true as open work, they are just no longer the
> next thing.

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

# 2026-09-05

## Phase 3 (LTI 1.3 / Canvas): PAUSED, not abandoned

No code was written and no migration was applied. The plan below was
corrected across two review rounds and is recorded verbatim so that
resuming does not mean re-deriving it. Priority moved to the four-stage
sequence in the next section.

### Blocking factual correction: which Canvas instance

**Canvas Free-for-Teacher cannot be used.** Instructure staff state in
their own community forums that FFT does not allow the account-admin
access required to create a Developer Key or install/test an LTI 1.3
tool, and that they cannot grant that access even temporarily. FFT
supports LTI 1.1 tools only; LTI 1.3 tools have to be added to the
instance by Instructure. An earlier version of this plan assumed FFT
would work -- it does not, and that assumption would have been discovered
only after the code was written.

**Target instance: self-hosted open-source Canvas running locally in
Docker.** Verified against that specific setup (the pylti1.3 project's
Canvas configuration guide, which registers exactly this shape): a local
Canvas Developer Key form accepts plain `http://127.0.0.1:<port>/...`
values for Redirect URI, Target Link URI, and OpenID Connect Initiation
URL, so the local-first test ordering is viable rather than assumed.
A local Canvas exposes `/api/lti/authorize_redirect`,
`/api/lti/security/jwks`, and `/login/oauth2/token`.

Two setup gotchas to expect, recorded so they are not rediscovered:
- The **LTI 1.3 feature flag** must be enabled in Settings -> Feature
  Options before Developer Keys offers LTI keys at all.
- Self-hosted Canvas frequently defaults its `iss` to
  `https://canvas.instructure.com` unless explicitly overridden in its
  config. Capture the real `iss` from a live login initiation and store
  whatever the instance actually sends; never assume it matches the
  hostname.

Cost/practicality: the Canvas Docker stack is a multi-gigabyte Rails +
Postgres + Redis application running under x86 emulation on Apple
Silicon. Budget roughly 10-15 GB of disk (for reference, this whole
project currently occupies 471 MB, 469 MB of which is `node_modules`).
Fallback if that proves impractical: an Instructure sales-arranged trial
instance with root admin, which is a contact-and-wait path, not
self-service.

Local cookie caveat: the state/nonce cookies must be
`SameSite=None; Secure` because the launch is a cross-site POST. Chrome
treats `localhost` as a trustworthy origin and will accept `Secure`
cookies there over plain http; Safari is a separate check, not assumed.

### Tables planned

All new/altered tables follow the standing convention without exception:
RLS enabled, default-deny for `anon`/`authenticated`, one explicit
`service_role`-only policy, **confirmed live via `pg_policies`** (policy
count, role, command) rather than assumed.

- **`lti_platforms`** -- per-platform registration, as DB rows rather
  than env vars, per spec 6.3 multi-tenancy: `id`, `issuer`, `client_id`,
  `auth_endpoint`, `token_endpoint`, `jwks_url`, `created_at`; unique on
  `(issuer, client_id)`.
- **`lti_course_links`** -- `platform_id`, `deployment_id`, `context_id`,
  `course_id -> courses(id)`, `created_at`; unique on
  `(platform_id, deployment_id, context_id)`. Resolving a launch through
  this table doubles as deployment_id validation: an unregistered
  deployment/context resolves to nothing and yields a clear "this Canvas
  course isn't linked yet" page, which is also the natural admin
  workflow.
- **`lti_identities`** -- `platform_id`, `subject` (the `sub` claim, the
  only guaranteed-stable identifier since email is optional in LTI and
  can be withheld by Canvas privacy settings), `auth_user_id uuid not
  null references auth.users(id)`, `email` (nullable), `name` (nullable),
  `created_at`; unique on `(platform_id, subject)` so create-or-return is
  race-safe via the same 23505 pattern already used by enrollments.
- **`lti_nonces`** -- replay protection at the DB layer per the standing
  guardrail rule. Keyed on **`(platform_id, nonce)`**, not `nonce` alone,
  since a nonce is only meaningful per issuer. Cleanup is a **scheduled
  sweep**, not opportunistic deletion on the request path.
- **`lti_launches`** -- the per-launch record. `id`, `platform_id`,
  `course_link_id`, `auth_user_id`, `resource_link_id`, `message_type`,
  `roles` (jsonb), `context_claim` (jsonb), `custom_claim` (jsonb),
  `created_at`. Exists because spec 6.8 says Canvas reports
  graded-assignment context at launch and 3.8 requires assessment mode to
  be a system-reported flag never inferred from conversation. Without
  this table the phase produces a shape that structurally cannot carry
  that flag, making Phase 4.3 a refactor instead of an addition.
  The redirect after launch carries `?launch=<id>`, and the client passes
  `launch_id` on chat requests; the server resolves the course *from the
  launch row* after verifying `launch.auth_user_id` matches the session
  user, so the launch id is the only thing passed through, never a
  trusted course id.
- **Alter `enrollments`** -- add nullable `student_id uuid` (named to
  match `student_interaction_history`, not `student_id_uuid`), a partial
  unique index on `(student_id, course_id) where student_id is not null`,
  a `role text not null default 'learner'` column with a CHECK
  constraint, and a backfill `UPDATE` joining existing rows to
  `auth.users` by email. `student_email` stays as an attribute, no longer
  the sole key.

### The four accepted fixes from final review

1. **`enrollments.student_id` FK to `auth.users` uses `ON DELETE
   RESTRICT`, not `ON DELETE CASCADE`.** Deleting an auth user who has
   enrollments should fail loudly rather than silently destroying the
   enrollment records; erasure becomes an explicit, ordered operation
   rather than a side effect. (Open question at resume: whether
   `lti_identities.auth_user_id` should be made RESTRICT for the same
   reason, since it was specced CASCADE and the two are now asymmetric.
   Not decided.)
2. **Platform resolution must key on issuer AND client_id together, as a
   hard rule.** Never issuer alone. A single issuer can host multiple
   client_ids (multiple registrations/tenants), so issuer-only resolution
   would cross tenants. The unique constraint already expresses this; the
   rule is that every lookup in `/api/lti/login` and `/api/lti/launch`
   must actually use both. Canvas supplies `client_id` in the login
   initiation and `aud` in the token.
3. **`lti_launches` still needs a retention classification.** Spec 3.2
   sets interaction-history deletion at thirty days after course
   completion; 9.3 leaves audit-log retention open. `lti_launches` holds
   launch context (roles, context, custom claims) tied to an identifiable
   student and is FERPA-relevant under Tier 3, so it has to be classified
   as one or the other before it holds real student data. Not decided.
4. **Two claims asserted in the plan are unverified and must be verified
   before anything relies on them:**
   - that memory / interaction-history writes in `/api/chat` are already
     conditional on a non-null `student_id` (this is the entire basis for
     the claim that anonymous public-course chat "simply accrues no
     history");
   - that **`pg_cron` is available and enabled on this Supabase project**
     for the scheduled `lti_nonces` sweep. If it is not, the sweep needs
     a different mechanism and the nonce-table design changes with it.

### Remaining plan detail (unchanged, still correct)

- **Identity resolution: match before mint.** Order is (1) `lti_identities`
  lookup on `(platform_id, sub)`; (2) on miss with an email claim present,
  look up `auth.users` by that email and link to the existing user; (3)
  mint a new auth user only when there is genuinely no match. Without
  step 2, a student who enrolled via Google and later launches from
  Canvas gets a second auth user, a second enrollment, and a second
  interaction history -- the same two-inconsistent-keys defect this
  project already found once, recreated one layer up. **Duplicate
  handling, explicitly:** if `createUser` fails on a duplicate email
  (race, or a listing miss), re-run the email lookup and link; never
  error out, never mint a second user. A 23505 on the `lti_identities`
  insert (two concurrent first launches) likewise re-selects and uses the
  winner's row.
- **Role gating.** Auto-enroll only on the `Learner` membership role, with
  the role stored on the enrollment row. An instructor clicking Course
  Navigation otherwise becomes a student enrollment and, downstream, a
  student in the interaction history and struggle-pattern aggregate. An
  instructor launch still gets identity resolution and a session but no
  enrollment, landing on an explicit "instructor view isn't built yet"
  page. Canvas's Student View test student launches with the Learner
  role, so an instructor can still exercise the real tutoring path
  through the supported Canvas mechanism.
- **Nonce handling is two separate checks, both required.** (1) The
  `id_token`'s `nonce` must equal the nonce *we issued* at login
  initiation, held in the HttpOnly cookie set by `/api/lti/login`, which
  proves this launch answers our request. (2) Insert into `lti_nonces`;
  a unique violation means replay and is rejected. The first is not
  implied by the second.
- **Session lifetime, stated rather than left implicit.** An LTI launch
  mints a standard Supabase session: ~1-hour access token, auto-refreshed
  by the middleware via a rotating refresh token, no absolute expiry by
  default, invalidated by sign-out or admin revocation -- identical to a
  Google-path session. So LTI-minted *identity* outlives the launch,
  exactly as join-code identity outlives the join. Recommendation was to
  accept this deliberately, because what spec 6.7 refused to let outlive
  its source is **launch context**, and launch context lives only in
  `lti_launches` rows passed explicitly: nothing launch-derived ever
  rides on the session, and access is re-gated per request by
  `can_access_course`. If a hard cap on the session itself is wanted,
  Supabase's time-boxed sessions (dashboard-configurable, Pro plan) is
  the clean lever. **Not yet chosen by the user.**
- **The `public` access-mode contradiction, resolved.** No session plus
  `access_mode = 'public'` means the chat proceeds anonymously and
  accrues no history; a 401 applies only when the course is not public.
  Encoded in a new SQL function **`can_access_course(p_student_id,
  p_student_email, p_course_id)`** at the DB layer per the standing
  guardrail rule: public -> allowed regardless of null identity;
  otherwise requires a live (unexpired) course and a matching enrollment
  by uuid or by the legacy email key. This also finally enforces spec
  6.12.2's "existing students lose active access at expiration," which
  is currently enforced nowhere at chat time.

### Test order (regression moved earlier, deliberately)

1. Migrations (all tables above, `can_access_course`, the nonce sweep),
   `pg_policies` verified per table.
2. `/api/chat` hardening: resolve the student server-side from the
   session, stop trusting the client-supplied `student_id`, gate on
   `can_access_course`.
3. **Browser regression of the Google -> join-code -> chat path, in the
   real UI, immediately after the contract change and before any LTI code
   is exercised.** Step 2 is the contract change; rule 1 exists because a
   silent break went undetected for weeks, and testing the existing path
   only after the new path succeeds reverses the discipline that rule
   encodes.
4. LTI code: `jose`, `lib/lti.ts`, `/api/lti/login`, `/api/lti/launch`,
   `/api/lti/jwks`, `/api/me`, `page.tsx` arrival handling.
5. Local Canvas stood up in Docker; Developer Key created there;
   `lti_platforms` and `lti_course_links` rows inserted from its real
   values.
6. Full launch test through the local Canvas UI: launch -> grounded chat
   answer; DB rows verified; replayed launch rejected; instructor launch
   gated; Student View launch enrolls as learner.
7. Deliberate `vercel --prod` with production redirect URIs added, live
   re-verification, notes updated.

Honest caveat recorded at pause: a local Docker Canvas cannot meaningfully
launch into the production URL for outside users, so production
verification against a *real institutional* Canvas stays gated on having
one. The claim available after step 7 is "verified end-to-end against a
real Canvas instance locally, deployed live, pending first institutional
registration" -- consistent with spec 6.8 and 9.2, which already list
Canvas rollout specifics as an open item pending a named institution.

### Canvas Developer Key settings (for when this resumes)

Created in the self-hosted instance at Admin -> Developer Keys -> + LTI
Key, manual configuration. Redirect URIs / Target Link URI ->
`/api/lti/launch`; OpenID Connect Initiation URL -> `/api/lti/login`;
JWK Method -> Public JWK URL -> `/api/lti/jwks`; LTI Advantage services
all **off** (no AGS/NRPS this phase); Placement: Course Navigation,
launch target **new tab**; Privacy Level **Public** (sends name and
email; "Anonymous" instead exercises the synthetic-email fallback).
Then toggle the key ON, copy the **Client ID** (not a secret -- it goes
in an `lti_platforms` row, never `.env.local`), install it in the test
course via Settings -> Apps -> + App -> By Client ID, and take the
**Deployment ID** from the installed app's details.

Launch-only LTI needs **no client secret**. Signature verification uses
Canvas's public keys; our own keypair matters only for LTI Advantage
services (grade passback, out of scope per the Section 5 wall), but
Canvas's key form requires a public JWK regardless, so the keypair is
generated now and we are AGS-ready later. The only new `.env.local` entry
is `LTI_TOOL_PRIVATE_KEY` (base64 PKCS8), generated locally, never from a
dashboard, and written by a script that does not print it -- and per the
standing rule, only after confirming no editor has `.env.local` open.

Iframe note: Chrome blocks Basic-auth prompts inside cross-origin
iframes, so an iframe-embedded launch would fail *silently* behind
`SITE_PASSWORD`. Hence new-tab placement for this phase. Iframe embedding
plus storage-partitioned cookies is a deliberate later step, not smuggled
into this one.

## New priority sequence (supersedes "In progress / next" above)

Each stage gates the next. Scope is all currently active courses, which
as of today is exactly one: MKTG365 (`access_mode = 'join_code'`, one
enrollment, one license-confirmed source document). "All active courses"
therefore means *built parameterized, not hardcoded to MKTG365*, rather
than meaning a large fleet.

1. **Persona and voice pass.** Cosmetic only, per spec 2.3. Must not
   touch any capability or guardrail logic.
2. **Distress-signal detection**, closing the top item of spec 9.1.
   Gates stages 3 and 4: both increase how much and how proactively the
   tutor talks to students, and doing that before this closes increases
   exposure to the exact risk 9.1 exists to catch.
3. **Pedagogy tuning**, scoped only to defects already diagnosed with
   real evidence: the retraction bug, the retrieval contamination bug,
   and the evidence-based comprehension-check verdict rule. Everything
   else in Section 13's tutoring parameter catalog stays frozen at its
   documented default, per the spec's own instruction not to tune ahead
   of real usage data.
4. **Struggling-student detection and proactive outreach** per spec 3.3,
   including building the scheduler that section says the engine does not
   have, and deciding the out-of-band contact channel and its opt-out
   mechanics (still listed open in 9.3). Largest new infrastructure in
   this sequence; goes last because it depends on stage 2.

### Stage 1 finding: persona is per program, and the schema has nowhere to put it

Confirmed from the spec before building, so no assumption gets baked in:
**persona is a per-program layer, not a single global voice.** Spec 1.3:
"It is not a single persona. Nancy, the demo TA, is retired. Persona is a
per-program layer, not a fixed identity." The Section 2 layer table gives
the axis as "Per program" with ACI warm practitioner / AIE graduate peer
/ TCI collegial academic, and 2.3 makes it strictly cosmetic: persona is
voice, never capability, precisely so a warm ACI tone cannot loosen a
for-credit integrity rule.

Two things block a clean start, both requiring a decision rather than an
assumption:
- **There is no program dimension anywhere in the system.** `courses` has
  no `program` column, there is no persona config table, and the system
  prompt is a single hardcoded global string at
  `app/api/chat/route.ts:181`. Per-program persona has nowhere to live
  yet. Which program MKTG365 belongs to (ACI, AIE, or TCI University
  Online) is not recorded anywhere and must not be guessed -- it also
  determines the guardrail tier, which is a *separate* axis that stage 1
  must not touch.
- **Spec 9.4 leaves a genuinely open product question:** "Persona
  identity per program: retire Nancy fully, or keep a named persona per
  surface?" The per-program axis is settled; whether each persona carries
  a *name* is explicitly undecided in the spec and is the user's call.
