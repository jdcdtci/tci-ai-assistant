import { createClient } from "@supabase/supabase-js";

// Uses Supabase's newer secret key (sb_secret_...) rather than the legacy
// service_role key. Same effective permissions -- Supabase's own docs:
// "Secret keys bypass Row Level Security and have full access to your
// data" -- but individually revocable, since it isn't a JWT tied to the
// project's shared JWT secret the way service_role is. Migrated after the
// legacy key was accidentally exposed in a local debugging session and
// turned out to be impossible to rotate on its own.
//
// Reads env vars at call time (not module load time) so this works whether
// they were populated by Next.js automatically or by a standalone script
// that loads .env.local itself before calling this.
export function getSupabaseServiceClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
}
