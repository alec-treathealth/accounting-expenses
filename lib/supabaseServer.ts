import { createClient } from "@supabase/supabase-js";

// Server-only admin client. Uses the service_role key, which bypasses RLS and
// can write to fact_txn / call rebuild_aggregates(). This module must never be
// imported into a client component.
/* The key goes straight into the `apikey` and `Authorization` HTTP headers, and
   header values are ByteStrings: any character above U+00FF makes fetch throw
   "Cannot convert argument to a ByteString" BEFORE a request is ever sent.
   That happened in production — the deployed key had picked up a stray U+2192
   arrow, so every /api/txn call died with a 500 and no outbound request to
   diagnose from. Surrounding whitespace and newlines are equally easy to paste
   in by accident, so trim first and then say plainly what is wrong. */
function headerSafeKey(raw: string): string {
  const key = raw.trim();
  const bad = [...key].findIndex((c) => c.codePointAt(0)! > 0xff);
  if (bad !== -1) {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY contains a non-ASCII character (U+${key
        .codePointAt(bad)!
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")}) at position ${bad}. It cannot be sent as an HTTP header — ` +
        "re-copy the service_role key from Supabase → Project Settings → API.",
    );
  }
  return key;
}

export function supabaseAdmin() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const raw = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!raw) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, headerSafeKey(raw), { auth: { persistSession: false } });
}
