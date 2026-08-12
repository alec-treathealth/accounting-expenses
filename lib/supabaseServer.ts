import { createClient } from "@supabase/supabase-js";

// Server-only admin client. Uses the service_role key, which bypasses RLS and
// can write to fact_txn / call rebuild_aggregates(). This module must never be
// imported into a client component.
export function supabaseAdmin() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) as string;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, key, { auth: { persistSession: false } });
}
