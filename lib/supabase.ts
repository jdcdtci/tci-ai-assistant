import { createClient } from "@supabase/supabase-js";

// Reads env vars at call time (not module load time) so this works whether
// they were populated by Next.js automatically or by a standalone script
// that loads .env.local itself before calling this.
export function getSupabaseServiceClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}
