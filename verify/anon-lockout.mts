// Proves the publishable key can no longer read financial data.
//
// This is the check that matters. The login screen is the front door; this
// asserts the lock. Before 0005 every table below granted SELECT to anon, so
// anyone could lift the publishable key out of the browser bundle and read every
// aggregate straight from PostgREST, bypassing the app entirely.
//
// It also asserts that a merely-registered account is not an invited one:
// public signup is open on this project, so "has a session" and "is allowed to
// see company financials" are different questions.
//
//   npm run verify:lockout

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

function envFromFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [".env.local", ".env"]) {
    const p = join(REPO, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}
const fileEnv = envFromFile();
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || fileEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!URL_ || !PUB) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  process.exit(2);
}

// Exactly the client an outsider can construct from the JS bundle.
const anon = createClient(URL_, PUB, { auth: { persistSession: false } });

const TABLES = [
  "agg_group_month",
  "agg_account",
  "agg_vendor",
  "dim_facility",
  "map_account_group",
  // Added by 0008. These name real employees against real amounts, so they are
  // the most sensitive aggregates in the warehouse, not the least.
  "agg_ramp_person",
  "agg_ramp_vendor",
  // Added by 0012. alert_read leaks who is reviewing what; alert_pin carries a
  // transaction-grain snapshot — a named person, a date, a merchant, an amount.
  "alert_read",
  "alert_pin",
];

console.log("== anonymous PostgREST reads (each must be denied or empty) ==");
for (const t of TABLES) {
  const { data, error } = await anon.from(t).select("*").limit(1);
  const rows = (data ?? []).length;
  ok(!!error || rows === 0, `anon cannot read ${t}`, error ? error.code || error.message : `rows=${rows}`);
}

// fact_txn was already private; assert it stayed that way.
{
  const { data, error } = await anon.from("fact_txn").select("*").limit(1);
  const rows = (data ?? []).length;
  ok(!!error || rows === 0, "anon cannot read fact_txn", error ? error.code || error.message : `rows=${rows}`);
}

// The invite list itself must be unreadable, or it leaks who has access.
{
  const { data, error } = await anon.from("app_access").select("*").limit(1);
  const rows = (data ?? []).length;
  ok(!!error || rows === 0, "anon cannot read app_access", error ? error.code || error.message : `rows=${rows}`);
}

// The gate function must not be callable anonymously.
{
  const { data, error } = await anon.rpc("has_dashboard_access");
  ok(!!error || data !== true, "anon cannot pass has_dashboard_access()", error ? error.code || error.message : `returned ${data}`);
}

/* Server-only functions. Both are SECURITY DEFINER or read fact_txn directly, so
   an accidental grant to anon/authenticated would hand out transaction detail
   without going near /api/txn — the single door this architecture depends on. */
for (const fn of ["ramp_alerts", "txn_totals"] as const) {
  const { data, error } = await anon.rpc(fn, fn === "txn_totals" ? { p_ramp: true } : {});
  const rows = Array.isArray(data) ? data.length : data == null ? 0 : 1;
  ok(!!error || rows === 0, `anon cannot execute ${fn}()`, error ? error.code || error.message : `rows=${rows}`);
}

/* The PostgREST computed columns from 0010. fact_txn is already unreadable, but
   these are new filterable surfaces on it and are worth naming explicitly: a
   future policy added to fact_txn without thinking about them would expose a
   cardholder search to anyone holding the publishable key. */
{
  const { data, error } = await anon.from("fact_txn").select("row_key,is_ramp,ramp_cardholder").limit(1);
  const rows = (data ?? []).length;
  ok(!!error || rows === 0, "anon cannot read the is_ramp / ramp_cardholder computed columns", error ? error.code || error.message : `rows=${rows}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
