A course-scoped AI teaching assistant for TCI. Students sign in with Google,
join a course section with a code, and ask questions that are answered
strictly from that course's own material, with built-in detection of and a
fixed, sourced response to student distress. Built on Next.js and Supabase.

**For current build status — what's deployed, what's verified, what's
outstanding, what's next — see the HANDOFF NOTE at the top of
[`SESSION_NOTES.md`](./SESSION_NOTES.md).** That file is the single source
of truth for project state and is updated every time something ships or
changes. This README does not duplicate it and will not track it; treat any
status claim here that contradicts `SESSION_NOTES.md` as this file being
stale, not the other way around.

## Stack

- **Next.js 16** (App Router, Turbopack) with React 19, deployed to Vercel
- **Supabase**: Postgres (with `pgvector`, `pg_cron`, `pg_net`, Vault) for
  data, auth (Google OAuth), and row-level security
- **Anthropic API** (`claude-sonnet-5`) for tutoring responses and distress
  classification
- **Voyage AI** (`voyage-3-large`) for embeddings, queried through a
  rate-limited queue backed by Upstash Redis
- **Resend** for escalation email to a section's designated staff

## Architecture

**Courses and sections.** A course (e.g. `MKTG365`) holds shared knowledge
material. A section is one offering of it: its own dates, join code, access
mode, crisis resource, and staff. `can_access_section` is a database
function and the single source of truth for whether a given signed-in (or,
where the section allows it, anonymous) caller may use it — entitlement is
decided in SQL, not in application code.

**Retrieval-augmented tutoring** (`app/api/chat`). A student's message is
embedded, matched against `knowledge_chunks` via `pgvector`, and answered by
Claude using only the retrieved material — the system prompt requires it to
say plainly when the material doesn't cover something rather than filling
the gap from general knowledge.

**Distress detection** (`lib/distress.ts`, `lib/distress-response.ts`). Every
message is classified on a five-level scale, independently of an
interpersonal-harm signal. The two highest levels get fixed, sourced
response text (not model-generated) and can override the normal entitlement
check entirely, so a distress disclosure gets a safe response even from an
unentitled or signed-out caller. A first crisis and a repeat crisis in the
same conversation get deliberately different text; which one fires is
decided against `distress_events` in the database, not by pattern-matching
conversation text, so it survives conversation history being restored from
storage.

**Chat history** (`conversations` / `messages`). Verbatim, multi-thread,
scoped through `can_access_section`. Any turn classified as
personal-distress-or-above, on either side of the exchange, is never written
to `messages` at all — only a uniform marker is, enforced by a CHECK
constraint that makes it structurally impossible for a marker row to also
carry content. The actual content lives solely in `distress_events`, under
its own retention clock, readable only by the section's accepted wellbeing
reader.

**Escalation notification** (`lib/notifications.ts`,
`app/api/internal/notify`). A scheduled sweep, run from Postgres via
`pg_cron`/`pg_net` rather than Vercel Cron, notifies a section's accepted
escalation recipient when a student crosses a notification threshold. The
email can contain identity and context — who, which section, when, why —
and is structurally incapable of containing the student's message text: the
type describing what an email may say has no field for it. A section with no
accepted recipient is recorded and never sent to, with no fallback address,
enforced by the database query itself rather than by application logic that
could be bypassed.

**Retention.** Distress event text, conversation history, and notification
records each purge on their own schedule via `pg_cron`, independently of one
another — deliberately, so that redacting content from one place (say,
`messages`) never depends on remembering to also redact it from another.

**A four-tier access structure exists in spec** — student, section-scoped
faculty dashboard, institution administration, and TCI's own operator
backend — with only the student tier and pieces of the section-scoped tier
built so far. See
[`TCI_AI_Teaching_Assistant_Spec_v3_8.md`](./TCI_AI_Teaching_Assistant_Spec_v3_8.md)
for what each tier is and does; that detail is not duplicated here for the
same reason build status isn't.

## Running locally

```bash
npm install
npm run dev
```

Requires a `.env.local` with, at minimum: `ANTHROPIC_API_KEY`,
`VOYAGE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and the Upstash
`KV_REST_API_*` / `REDIS_URL` variables used for rate limiting. The
escalation-email path additionally reads `RESEND_API_KEY`,
`NOTIFY_FROM_ADDRESS`, `NOTIFY_SIGN_IN_URL`, and `NOTIFY_SWEEP_SECRET` — see
`SESSION_NOTES.md` for whether those are currently configured and why.

The whole site can sit behind an HTTP Basic gate controlled by
`SITE_PASSWORD`; unset, or run with `SITE_PASSWORD=` prefixed, to disable it
locally. Database migrations live in `supabase/migrations/` and are applied
directly against the one Supabase project shared by local and production —
there is no separate staging database.

## Standing project rules

- Any change to an API route's request or response contract gets a UI-level
  test, not just `curl` — a past incident here shipped a change that passed
  every automated check while quietly breaking the live chat UI for days.
- Safety guarantees (access control, redaction, retention) live in the
  database as RLS policies, CHECK constraints, triggers, and `SECURITY
  DEFINER` functions — verified by reading the deployed object back, not
  assumed from a migration file.
- Deployment is a manual `vercel --prod`; nothing auto-deploys.
- Secrets are never printed to a transcript or a terminal; inspect
  `.env.local` by variable name only.

See `SESSION_NOTES.md` for the full reasoning behind each of these and the
complete running history of the project.
