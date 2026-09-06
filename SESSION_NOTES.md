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

### Stage 1 DONE: persona and voice pass

Both blocking decisions were made by the project owner and are now
recorded in the system rather than only in conversation:

- **MKTG365 is TCI University Online**, the for-credit business catalog.
  Stated explicitly by the owner, not inferred from the course code.
  Nothing in the codebase, database, or spec recorded this before; the
  course source document header ("La Sierra University / Tom and Vi
  Zapara School of Business / MKTG 365 Marketing Research") and the
  spec's definition of TCI University Online as for-credit degree courses
  licensed to universities corroborate it but did not establish it.
- **Personas stay unnamed for now**: role-based voice only (ACI warm
  practitioner, AIE graduate peer, TCI collegial academic), no proper
  name on any surface. Reason recorded because it is a real safety
  judgment, not a style preference: a named persona invites more
  relational trust from a student than an unnamed one, which is a larger
  commitment to take on while spec 9.1's distress-signal detection is
  still unbuilt. **Revisit naming after stage 2 closes, not before.**

**What was built.**
- Migration `20260906024655_add_program_to_courses.sql`: adds
  `courses.program`, NOT NULL, **no default**, CHECK constrained to
  `('aci','aie','tci')` matching the lowercase `access_mode` convention
  on the same table. Backfilled MKTG365 to `'tci'`, with a guard block
  that raises rather than proceeding if any course row would have been
  left without a program. No default is deliberate: a defaulted or null
  program is harmless while this column only drives tone, but becomes
  dangerous the moment guardrail tier binds to it, since spec 2.4
  requires a for-credit course to inherit the strictest tier "without
  anyone remembering to set it."
- `lib/persona.ts`: the three voices, plus `buildVoiceSection()`, which
  appends an explicit precedence statement to the prompt ("This section
  governs tone only... Where anything here appears to conflict with a
  rule above, that rule governs") and the no-personal-name instruction.
  An unrecognized or missing program returns no voice section at all and
  logs a warning, rather than guessing a register.
- `app/api/chat/route.ts`: the course lookup runs in `Promise.all`
  alongside retrieval (they are independent), and `buildSystemPrompt`
  appends the voice block after the engine rules, never woven into them.
  A failed course lookup logs and degrades to the default voice; persona
  is cosmetic and must never cost a student an answer.

**Guardrail tier is not touched by this column, confirmed in writing.**
`program` is read by persona selection and nothing else. No guardrail,
capability, refusal, academic-integrity, privacy, or access-control code
reads it, and no tier is bound to it. That statement is also recorded in
the migration file itself and in the header of `lib/persona.ts`, along
with the test for future edits to that file: if a line would change the
assistant's behavior for a student who asked it to do something it should
not do, it does not belong in the persona layer. Spec 2.3 is the reason
(a warm tone must never be able to loosen a for-credit integrity rule),
and binding tier to this same column later is expected, correct, and a
separate piece of work with its own review.

**Verified.**
- Column state confirmed live: NOT NULL, no default,
  `courses_program_check` present, MKTG365 = `tci`.
- RLS on `courses` re-verified after the migration via `pg_policies`:
  still enabled, still exactly one `service_role` ALL policy,
  default-deny for `anon`/`authenticated` intact, pre-existing
  `access_mode` and escalation CHECK constraints untouched.
- All three voice sections render correctly; `bogus` and `undefined`
  both degrade to the default engine voice and log.
- Real request against the local dev server returned a grounded,
  correctly-patterned tutoring response in an unmistakably
  collegial-academic register, with no `[persona]` warning in the logs,
  confirming the lookup resolved and the TCI voice was actually applied.
- Unknown-course fallback returns 200 with the warning logged, no crash.
- `tsc --noEmit` and `eslint` clean apart from pre-existing issues (the
  `LayoutProps` generated-type error in `app/layout.tsx` and two
  unused-`err` warnings in catch blocks that predate this work).

**Not verified, and worth being precise about.** The student-facing
browser UI was NOT exercised end to end for this change. The chat screen
sits behind Google sign-in, which cannot be completed without entering
credentials, and the separate real-Chrome surface cannot reach the local
dev server at all (different network context). What was confirmed in a
real browser is that the app loads and renders the sign-in screen
correctly. The UI code was not modified by this stage and the route's
request/response contract is unchanged, so this is a lower-risk gap than
the one rule 1 was written for, but it is a gap: a signed-in pass through
the real chat screen is still worth doing at the start of the next
session.

**Local testing note.** `SITE_PASSWORD` is set in `.env.local`, so the
whole-site gate is active locally and blocks automated browser testing.
Running `SITE_PASSWORD= npm run dev` disables it for that process only
(the middleware no-ops when the value is empty), touching no file and
leaving production unaffected. `.claude/launch.json` was temporarily
changed to do this during testing and has been **restored to its
original contents**; use the env prefix ad hoc rather than committing it.
Also note the Upstash credentials (`KV_REST_API_*`) live in
`.env.development.local`, not `.env.local`, which is why local
`/api/chat` works despite those names being absent from the latter.

**Not done in the persona pass, deliberately.** Spec 3.1's "warmth
without authority" rule was left out of stage 1 because it is a
capability boundary, not voice, and stage 1 was scoped to cosmetic
changes only. It was patched separately immediately afterward, see below.

### Warmth-without-authority guardrail: PATCHED and verified

Done as its own small piece of work rather than folded into stage 2,
because it was a live gap on a real for-credit course with real students
and is a prompt-level guardrail fix, not new infrastructure.

Added to `SYSTEM_PROMPT` in `app/api/chat/route.ts`, as its own paragraph
in the engine rules ahead of the tutoring pattern (it is a boundary, not
a pattern step): the assistant has no authority over any part of the
course beyond explaining its material; never suggests it can grant an
extension, waive a requirement, override a policy, or speak for the
instructor's judgment on a grade or accommodation; and specifically never
characterizes how easy, hard, or fair an upcoming graded assessment will
be, nor reassures a student about how a quiz, exam, or assignment is
likely to go. Rationale is stated inside the prompt itself: the assistant
does not know how the assessment was written, graded, or calibrated, so
any such comment is a claim it cannot support and may be flatly wrong in
a way that costs the student's trust.

Scope: **confirmed to stay as written, not trimmed.** The original
request was specifically the easy/hard/fair rule, and the immediate
parent clause (extension, waiver, policy override, speaking for faculty
judgment) was included with it because spec 3.1 frames the assessment
rule as an extension of that broader authority boundary. Confirmed by
the project owner on the reasoning that a system which will not
characterize a quiz's difficulty but would still grant an extension or
override a policy is not a coherent guardrail: 3.1's full clause belongs
together. Do not narrow this later without revisiting that reasoning.

Verified live against the local dev server:
- Asked "We have a quiz on research design coming up. Is it hard? Should
  I be worried about it?" The response declined to characterize
  difficulty or grading, said plainly that only the instructor can speak
  to that, noted that a guess from it would not be worth trusting,
  offered to work through the material, and still closed with a real
  construction check. Warm, and without borrowed authority.
- Regression against over-firing: "What is the difference between
  internal and external validity?" still returned a full, grounded,
  substantive answer. The new paragraph does not make ordinary content
  questions evasive.

### Persona name audit (explicitly run, not inferred)

Asked for directly, and worth recording that the check had NOT been run
when stage 1 was first reported: the voices were authored without names
and with an explicit no-name instruction, but that is authorship, not
verification. The audit has now actually been run against the string
contents:
- "Nancy" occurs exactly once repo-wide, in a **code comment** at
  `lib/persona.ts:32` quoting spec 9.4's open question. It is not inside
  any string and never reaches the model.
- Every capitalized word inside the three voice strings is sentence
  initial (Address, Draw, Favor, Ground, Keep, Prefer, Sound, Stay, They,
  Treat, Use, You). `Program` and `Record` appear only in the TypeScript
  type annotation `Record<Program, string>` on the declaration line, not
  in prompt text.
- Same for the shared assembled block; `DB` and `JSON` come from a
  comment and from `JSON.stringify` in the warning path.
- The explicit instruction is present: no personal name, refer to
  yourself as the course assistant, do not adopt or invent one even if a
  student offers.
**Result: no proper name exists in any of the three voices.**

### Stage 1 is NOT fully closed: the signed-in UI test is blocked on the owner

Attempted this session and genuinely blocked, not skipped. The chat
screen requires a Google sign-in. In the automated browser, clicking
"Sign in with Google" correctly redirects to Google's OAuth page for the
Supabase project, and that page presents a full credential form: email,
password, **and a CAPTCHA**. There is no existing Google session in that
browser and no account chooser. Entering credentials and completing
CAPTCHAs are both off limits, so this cannot be finished without the
owner. The separate real-Chrome surface is not a workaround either: it
cannot reach the local dev server at all (different network context).

**To finish it (about two minutes, needs a human at the keyboard):**

```
SITE_PASSWORD= npm run dev
```

Then at http://localhost:3000 : sign in with Google, enter join code
`A4D3KAWR` for MKTG365, and send two messages. First, any ordinary
content question, confirming a normal grounded answer arrives in the
chat UI (this is the rule 1 check that the persona work and the course
lookup did not break the real interface). Second, "Is the upcoming quiz
hard?", confirming the new authority guardrail holds in the UI exactly
as it did against the API.

Everything else in stage 1 and the guardrail patch is verified. Stage 2
(distress-signal detection) has NOT been started, because stage 1 was
gated on this UI test.

### Captured feature request: assessment-scope clarifying sequence (BLOCKED, do not build)

> **Status: blocked on two items, neither of which is a build-time
> judgment call.** (1) The feature cannot meet spec 3.8's system-reported
> assessment context requirement without new infrastructure that does not
> exist. (2) Whether it should exist in MKTG365 at all is MKTG365's
> instructor's decision and has not been made. Both are detailed below.
> Do not begin any part of this, including targeted-lookup work framed as
> preparation.

Requested 2026-09-05: after a student asks about a quiz, test, or
assignment, the assistant should (1) ask which one is coming up, (2) ask
whether there is a specific area they are worried about, then (3) list
the topic areas for that assessment. Recorded here with the research
done, so the design work is not repeated. **Not built, not scheduled.**

**Feasibility: better than expected. The material exists and is legally
retrievable.** The obvious worry was that "list what is on the quiz"
collides with the `answer_bearing` guardrail. It does not, and the
distinction matters: `answer_bearing` tags graded assignment *prompts*
(21 chunks, e.g. "Activity 4-2: Survey Instrument Design. Design a
15-question survey..."), which is the leak that once had the assistant
performing an assignment live. Published *scope statements* are a
different class of content. MKTG365 contains at least seven
"ASSESSMENT CONTENT / TOPICS COVERED" blocks, all `answer_bearing =
false` and therefore already retrievable, listing topics per unit
(secondary research; survey instruments; observational research;
experimental research; multivariate analysis; digital analytics; and
more). So step 3 is groundable without weakening any guardrail.

**The real engineering problem: retrieval is not guaranteed to land on
the right block.** Retrieval embeds the student's message. "Quiz 3"
carries almost no semantic signal toward a block whose text is "internal
secondary data: sales records, CRM data, and transaction databases," so
the likely failure is that retrieval returns ordinary course content, the
model has plausible-looking material in context, and improvises a topic
list. That is an ungrounded factual claim about a graded assessment, and
it is worse than the difficulty-characterization gap just patched:
specific, actionable, and a student will study from it. Any build needs a
**targeted lookup of the assessment-scope blocks rather than
embedding-luck**, plus an explicit refusal path when the block for the
named assessment is not found. A prompt-only change cannot do this.

**No concept of "upcoming" exists.** There is no assessments table, no
dates, no schedule, and no notion of where a student is in the course
(tables are only `courses`, `enrollments`, `knowledge_chunks`,
`knowledge_documents`, `student_interaction_history`). Asking the student
which assessment is coming up is a sound compensation for that, but the
assistant cannot validate the answer, cannot know whether a named
assessment exists, and the scope blocks do not appear to carry
student-facing assessment names to match against.

**BLOCKING ITEM 1: this feature cannot meet spec 3.8 without new
infrastructure. Correction to earlier analysis in this same entry.**
The self-reported assessment identity problem was first framed here as
something a targeted lookup would solve. That was wrong, and the
correction matters more than the original point. Targeted lookup solves
"does "Quiz 3" reach the right scope block." It does nothing about
whether there is a Quiz 3, whether it is upcoming, or whether it is this
student's. A flawless lookup still hands over real assessment content on
the strength of an unverified student claim. **Do not build the lookup as
a fix for this.**

What 3.8 literally says: assessment mode "is not a judgment the assistant
makes. It is a context flag the system already knows and truthfully
reports," with "the source of truth is the LMS, not the model's
inference," carried on the normalized context object as a field
"reported by the system, never inferred by the assistant." Note precisely
what that covers: 3.8 defines a **boolean** (is this student inside a
live assessment right now) governing a restrictive mode. It does not
literally define an assessment **identity and timing** signal (which
assessment, and is it genuinely upcoming for this student). Extending
3.8's principle to identity and timing is a correct extension, and
arguably binds harder here, since this feature *discloses* content on the
strength of the claim rather than merely restricting behavior. But it is
an extension of the stated rule to a case the spec does not literally
address, and the spec would be better for saying so explicitly.

**What would actually constitute a system-reported signal, assessed
honestly:**
- **LTI launch context (spec 6.8) is the canonical source.** Canvas
  reports graded-assignment context at launch via `resource_link`,
  `message_type`, and custom claims: signed, LMS-sourced, not student
  asserted. This is exactly what the paused Phase 3 `lti_launches` table
  was designed to carry. Two limits: Phase 3 is paused and unbuilt, and
  even once built a launch reports *the context the student launched
  from*, which is close to 3.8's boolean. It does not report "Quiz 3 is
  due Friday."
- **An assessments table with authoritative identity and timing.** Would
  need assessment id, student-facing name, course, open/due dates, and a
  link to its scope block(s), populated from authoritative course data
  rather than student claims, plus a clock to resolve "upcoming." **No
  such table exists**; the schema is only `courses`, `enrollments`,
  `knowledge_chunks`, `knowledge_documents`,
  `student_interaction_history`. Even with it, "upcoming *for this
  student*" depends on section, enrollment dates, and any individual
  extension or accommodation, so a single course-level due date is an
  approximation that can be wrong for a given student.
- **LMS assignment/schedule data via LTI Advantage (AGS).** Genuinely
  authoritative, and explicitly out of scope: the Phase 3 plan turns AGS
  and NRPS off, and grade passback sits behind the Section 5 wall.

**Plain answer: no system-reported signal about assessment identity or
timing exists anywhere in this system today, and none can be obtained
without new infrastructure.** Everything currently available is student
self-report. This is not a prompt change and not a retrieval change. It
requires a new data model for assessments including timing, an
authoritative population path for it, linkage from assessments to scope
blocks, and realistically the 3.8 assessment-mode flag itself. That is
comparable in size to stage 4's scheduler work, not to stage 1.

**Related hazard found while assessing this: assessment mode does not
exist yet.** Because the 3.8 flag is unbuilt, nothing currently prevents
a student who is *inside* a live quiz from asking "what topics are on my
upcoming quiz" and receiving a scope listing mid-assessment. Scope
disclosure during a live assessment is a real narrowing aid: knowing a
quiz covers "internal validity threats: history, maturation, selection
bias, mortality, testing effects, and instrumentation" while sitting in
that quiz is meaningful help. So this feature interacts badly with the
absence of assessment mode, independent of the self-report problem.

**BLOCKING ITEM 2: whether this feature should exist in MKTG365 at all is
the instructor's decision, and it has not been made.** Whether the
assistant should proactively surface assessment scope to students on its
own initiative, unprompted by a student naming a specific worry, is a
real pedagogical and course-policy decision with a real owner who is not
in the build conversation. The project owner is raising it with MKTG365's
instructor separately. **Until that answer comes back, this stays fully
unbuilt, not partially built and waiting.** Specifically: do not start the
targeted-lookup work as preparation. Neither blocker is a sequencing
question to be resolved when convenient, and neither is the build
decision of whoever picks this up next.

**Why timing would also matter, on the project's own gating logic
(secondary to both blockers above).**
Step 2 of the sequence literally asks the student what they are *worried*
about, which deliberately steers conversations toward expressions of
worry and anxiety. That is the exact signal class spec 9.1's
distress-signal detection exists to catch, and it is unbuilt. The
standing rule is that stage 2 gates stages 3 and 4 because both increase
how much and how proactively the tutor talks to students; a feature whose
design intent is to elicit statements of worry increases exposure in
precisely that way. Separately, stage 3 was scoped to only the three
evidence-diagnosed defects with the rest of Section 13 frozen per the
spec's instruction not to tune ahead of real usage data, and this is new
tutoring behavior rather than one of those three.

**Design notes for when it is built.** Do not force two questions before
any help: a student anxious about an assessment who is interrogated twice
before receiving substance is a plausible disengagement path, and the
existing pattern deliberately avoids forced checks. Skip straight to the
scope listing when the student has already named the assessment, and ask
the clarifying question only when the answer would actually change.

**Local testing note (repeat, because it will come up every time).**
`SITE_PASSWORD` is set in `.env.local`, so the whole-site gate is active
locally and blocks automated browser testing. The `SITE_PASSWORD= `
prefix above disables it for that one process (the middleware no-ops on
an empty value), touching no file and leaving production unaffected.
`.claude/launch.json` was temporarily pointed at that command during
testing and has been restored to its original contents both times.
The Upstash credentials (`KV_REST_API_*`) live in
`.env.development.local`, not `.env.local`, which is why local
`/api/chat` works despite those names being absent from the latter.
