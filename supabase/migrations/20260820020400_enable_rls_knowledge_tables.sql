-- These tables are only ever accessed by trusted server-side code using
-- the Supabase service_role key, which bypasses RLS by design — so these
-- policies add no restriction on that path. What they defend against is
-- Supabase's REST API (PostgREST), which auto-exposes every public-schema
-- table over HTTP. The anon key is not secret (it's designed to be
-- embeddable client-side), so without RLS, anyone holding it could read
-- or write these tables directly, regardless of how this app is built.
-- Enabling RLS with no anon/authenticated policy makes that access
-- default-deny; the explicit service_role policy documents intent rather
-- than relying on the bypass behavior alone.
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;

create policy "Service role full access"
  on public.knowledge_documents
  for all
  to service_role
  using (true)
  with check (true);

create policy "Service role full access"
  on public.knowledge_chunks
  for all
  to service_role
  using (true)
  with check (true);
