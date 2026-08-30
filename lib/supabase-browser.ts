import { createBrowserClient } from "@supabase/ssr";

// Client-side Supabase client for the browser: uses the public anon key,
// safe to expose, scoped by RLS (which on this project is default-deny for
// anon/authenticated -- this client only ever drives auth, never queries
// tables directly).
export function getSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
