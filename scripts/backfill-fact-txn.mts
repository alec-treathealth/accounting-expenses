// TEMP one-off backfill loader: parses the consolidated transaction detail CSV
// with the app's own parser and appends the rows to fact_txn via service_role,
// exactly as /api/ingest phase "rows" does. Deliberately does NOT call
// rebuild_aggregates(): the parsed aggregates were verified identical to the
// live agg_* tables, so the dashboard is left untouched.
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { ingestCsv } from "../lib/parse.ts";

const CSV = "/Users/aleclowi/accounting/Consolidated View_Consolidated transaction detail backfill.csv";

// Load .env.local the same way the Next.js app does when it boots.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const r = ingestCsv(readFileSync(CSV, "utf8"));
/* This path has NO preview and NO confirm step -- it writes straight to
   fact_txn. It is therefore the one that most needs the structural check the
   upload dialog performs, not the one that can skip it. */
if (r.anomalies.length) {
  console.error(`REFUSING: ${r.anomalies.length} structural anomaly(ies) in ${CSV}`);
  for (const a of r.anomalies) console.error("  ! " + a);
  process.exit(1);
}
console.log(`parsed ${r.factRows.length} fact rows, total ${r.total.toFixed(2)}`);

const CHUNK = 500;
let inserted = 0;
for (let i = 0; i < r.factRows.length; i += CHUNK) {
  const batch = r.factRows.slice(i, i + CHUNK);
  const { error, count } = await sb
    .from("fact_txn")
    .upsert(batch, { onConflict: "row_key,occurrence", ignoreDuplicates: true, count: "exact" });
  if (error) {
    console.error(`batch @${i} failed:`, error.message);
    process.exit(1);
  }
  inserted += count ?? 0;
  if ((i / CHUNK) % 10 === 0 || i + CHUNK >= r.factRows.length) {
    console.log(`  ${Math.min(i + CHUNK, r.factRows.length)}/${r.factRows.length} sent, ${inserted} inserted`);
  }
}
console.log(`DONE: ${inserted} rows inserted`);

const { count: final } = await sb.from("fact_txn").select("*", { count: "exact", head: true });
console.log(`fact_txn now holds ${final} rows (expected ${r.factRows.length})`);
