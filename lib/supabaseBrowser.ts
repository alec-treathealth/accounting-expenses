import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazily created so the client is only constructed in the browser at runtime
// (where NEXT_PUBLIC_* are inlined) — not at module import during the build
// prerender, which would throw if the env vars aren't set yet.
let client: SupabaseClient | null = null;

export function getSupabaseBrowser(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
