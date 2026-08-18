// Proves the /api/txn drill-down logic without touching production data.
//
// fact_txn is empty in the live project (it is seeded by the CSV upload flow),
// so this harness builds the fact rows locally with the real parser and runs the
// REAL query code (lib/txnQuery.ts: parseTxnParams + fetchTxnPage) against an
// in-memory PostgREST stand-in. It then reads the LIVE agg_group_month with the
// publishable key and asserts the drilled rows sum, to the penny, to the figure
// the dashboard displays.
//
// Read-only. Nothing here writes to Supabase.
//
//   npm run verify:drilldown -- /path/to/export.csv
//   EXPENSE_CSV=/path/to/export.csv npm run verify:drilldown

import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { ingestCsv, type FactRow } from "../lib/parse.ts";
import {
  fetchTxnPage,
  loadAllowlists,
  parseTxnParams,
  resetAllowlistCache,
  type Allowlists,
  type PgBuilder,
  type PgResult,
  type TxnDb,
  type TxnFilters,
} from "../lib/txnQuery.ts";
import { authorizeTxnRequest } from "../lib/txnAuth.ts";
import { isRampSplit, rampPerson } from "./rampRule.mts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

// --- 1. fixture -------------------------------------------------------------

function findCsv(): string {
  const explicit = process.argv[2] || process.env.EXPENSE_CSV;
  if (explicit) {
    if (!existsSync(explicit)) { console.error(`CSV not found at: ${explicit}`); process.exit(2); }
    return explicit;
  }
  for (const dir of [REPO, resolve(REPO, ".."), resolve(REPO, "../..")]) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    const hit = names.filter((f) => f.toLowerCase().endsWith(".csv") && /consolidated transaction detail/i.test(f)).sort();
    if (hit.length) return join(dir, hit[0]);
  }
  console.error('Could not find a "Consolidated transaction detail" CSV. Pass one: npm run verify:drilldown -- /path/to.csv');
  process.exit(2);
}

const csvPath = findCsv();
const ing = ingestCsv(readFileSync(csvPath, "utf8"));
console.log("source            :", csvPath);
console.log("fixture fact rows :", ing.factRows.length, "totalling $" + ing.total.toFixed(2));
/* This is the total OF THE CSV FIXTURE, which is no longer the same as the
   warehouse total, and the difference is not an error:

     23,108,706.41  what the Aug 18 2026 export parses to
     23,209,169.29  what fact_txn holds

   St. Louis Mental Health is absent from the newer export but its $98,662.71
   remains in fact_txn, because ingest reports rows it cannot find rather than
   deleting them. The warehouse is the union of every export ever loaded; a
   single file is not.

   Two exports now sit beside the repo, so findCsv() picks by directory order.
   Pass the file explicitly to compare against a known figure:
     npm run verify:drilldown -- "/path/to/...by account (1).csv" */
const FIXTURE_TOTALS: Record<string, string> = {
  "23108706.41": "Apr 1 – Aug 18 2026 export (adds Red Rock Behavioral Health)",
  "22851611.16": "Apr 1 – Aug 11 2026 backfill export",
};
const known = FIXTURE_TOTALS[ing.total.toFixed(2)];
ok(known !== undefined, "fixture ties out to a known export total",
   known ? `$${ing.total.toFixed(2)} — ${known}` : `$${ing.total.toFixed(2)} matches no known export`);

// --- 2. in-memory PostgREST stand-in ---------------------------------------
// Implements only what lib/txnQuery.ts uses: select(count/head), eq, or, order,
// range. The production query-building code runs unchanged against it.

type Row = Record<string, any>;

function makeDb(tables: Record<string, Row[]>): TxnDb {
  function builder(table: string, columns: string, count?: "exact", head?: boolean): PgBuilder {
    const eqs: [string, unknown][] = [];
    const ors: string[] = [];
    const orders: [string, boolean][] = [];
    let lo = 0;
    let hi = Number.MAX_SAFE_INTEGER;

    const run = (): PgResult => {
      const src = tables[table];
      if (!src) return { data: null, error: { message: `relation "${table}" does not exist` }, count: null };
      let out = src.filter((r) =>
        eqs.every(([c, v]) => String(r[c] ?? "") === String(v)) &&
        ors.every((o) => {
          if (o === "name.is.null,name.eq.") return r.name === null || r.name === undefined || r.name === "";
          throw new Error("unsupported or() in fixture: " + o);
        }),
      );
      const total = out.length;
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i];
        out = [...out].sort((a, b) => {
          const x = a[col], y = b[col];
          const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
          return asc ? c : -c;
        });
      }
      const sliced = out.slice(lo, hi === Number.MAX_SAFE_INTEGER ? undefined : hi + 1);
      const cols = columns.split(",").map((c) => c.trim());
      const data = head ? null : sliced.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      return { data, error: null, count: count === "exact" ? total : null };
    };

    const self: PgBuilder = {
      eq(c, v) { eqs.push([c, v]); return self; },
      or(f) { ors.push(f); return self; },
      order(c, o) { orders.push([c, o?.ascending !== false]); return self; },
      range(from, to) { lo = from; hi = to; return self; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return self;
  }

  return {
    from(table: string) {
      return { select: (columns: string, opts?: { count?: "exact"; head?: boolean }) => builder(table, columns, opts?.count, opts?.head) };
    },
  };
}

/* is_ramp and ramp_cardholder are PostgREST COMPUTED columns in production
   (supabase/migrations/0010), evaluated by Postgres. The fixture has no Postgres,
   so it materialises them here with the independent restatement in
   verify/rampRule.mts — which verify/ramp.mts separately proves agrees with the
   SQL against the live warehouse. */
const factRows: Row[] = ing.factRows.map((f: FactRow) => ({
  ...f,
  kind: f.kind,
  loaded_at: "2026-08-11T00:00:00Z",
  is_ramp: isRampSplit(f.split),
  ramp_cardholder: rampPerson(f.description),
}));
const rampFixture = factRows.filter((r) => r.is_ramp);
const db = makeDb({
  fact_txn: factRows,
  dim_facility: [...new Set(ing.factRows.map((f) => f.facility))].map((facility) => ({ facility })),
  agg_account: ing.aggAccount.map((a) => ({ account_label: a.account_label })),
  agg_vendor: ing.aggVendor.map((v) => ({ vendor: v.vendor })),
  agg_ramp_person: [...new Set(rampFixture.map((r) => r.ramp_cardholder))].map((person) => ({ person })),
});
const emptyDb = makeDb({
  fact_txn: [],
  dim_facility: [{ facility: "Hillside" }],
  agg_account: [],
  agg_vendor: [],
  agg_ramp_person: [],
});

resetAllowlistCache();
const allow: Allowlists = await loadAllowlists(db);
console.log("whitelists        :", allow.facilities.size, "facilities,", allow.groups.size, "groups,", allow.accounts.size, "accounts,", allow.vendors.size, "vendors");

// --- 3. filter validation (fail-closed, whitelisted) ------------------------

console.log("\n== filter validation ==");
const parse = (qs: string) => parseTxnParams(new URLSearchParams(qs), allow);
const code = (qs: string) => { const r = parse(qs); return r.ok ? "ok" : r.code; };

ok(code("") === "filter_required", "unfiltered request refused", code(""));
ok(code("limit=100") === "filter_required", "paging params alone are not a filter", code("limit=100"));
ok(code("facility=Nowhere") === "bad_facility", "unknown facility refused", code("facility=Nowhere"));
ok(code("facility=Hillside'--") === "bad_facility", "injection-shaped facility refused", code("facility=Hillside'--"));
ok(code("month=2026-13") === "bad_month", "impossible month refused", code("month=2026-13"));
ok(code("month=2026-7") === "bad_month", "unpadded month refused", code("month=2026-7"));
ok(code("posted_period=2026-07-15") === "bad_period", "mid-month posted_period refused", code("posted_period=2026-07-15"));
ok(code("kpi_group=Payroll") === "bad_kpi_group", "unknown kpi_group refused", code("kpi_group=Payroll"));
ok(code("account_label=6000%20Nope") === "bad_account_label", "unknown account refused", code("account_label=6000%20Nope"));
ok(code("vendor=Nobody%20Inc") === "bad_vendor", "unknown vendor refused", code("vendor=Nobody%20Inc"));
ok(code("month=2026-07&limit=5000") === "bad_limit", "limit above the 500 cap refused", code("month=2026-07&limit=5000"));
ok(code("month=2026-07&limit=0") === "bad_limit", "limit 0 refused", code("month=2026-07&limit=0"));
ok(code("month=2026-07&offset=999999") === "bad_offset", "offset above the 20000 cap refused", code("month=2026-07&offset=999999"));
ok(code("month=2026-07&sort=amount;drop") === "bad_sort", "non-whitelisted sort column refused", code("month=2026-07&sort=amount;drop"));
ok(code("month=2026-07&dir=sideways") === "bad_dir", "bad sort direction refused", code("month=2026-07&dir=sideways"));
ok(code("month=2026-07") === "ok", "valid month accepted");
ok(code("posted_period=2026-07-01") === "ok", "posted_period form accepted");

// --- Ramp / cardholder filters ---------------------------------------------
// `ramp` alone selects 24,226 rows — 81% of the warehouse — so it must NOT
// satisfy filter_required. A named cardholder must.
ok(code("ramp=1") === "filter_required", "ramp alone is not a filter", code("ramp=1"));
ok(code("ramp=yes") === "bad_ramp", "a mistyped ramp value is refused, not read as false", code("ramp=yes"));
ok(code("person=Nobody%20Here") === "bad_person", "unknown cardholder refused", code("person=Nobody%20Here"));
ok(code("person=Gia%20Laubertie") === "ok", "known cardholder accepted on its own");
ok(code("ramp=1&month=2026-07") === "ok", "ramp narrows a filter that already exists");
{
  // A person IMPLIES ramp, and the implication must be applied where the filter
  // set is produced — otherwise the page query and txn_totals() would disagree
  // and the drawer would report "does not reconcile" against itself.
  const r = parse("person=Gia%20Laubertie");
  ok(r.ok && r.filters.ramp === true, "a cardholder implies the Ramp restriction");
  const q = parse("month=2026-07");
  ok(q.ok && q.filters.ramp === false && q.filters.person === null, "a plain drill sets neither flag");
}
{
  const r = parse("facility=Hillside&month=2026-07&kpi_group=Payroll%20Expenses");
  ok(r.ok && r.filters.limit === 100 && r.filters.offset === 0 && r.filters.sort === "txn_date" && r.filters.dir === "asc",
    "defaults are limit=100, offset=0, sort=txn_date asc");
}

// --- 4. auth gate -----------------------------------------------------------

console.log("\n== auth gate (lib/txnAuth) ==");
const hdrs = (h: Record<string, string>) => ({ headers: { get: (k: string) => h[k.toLowerCase()] ?? null } });
/* The session probe is injected, so the whole gate stays testable offline: no
   Supabase round-trip, no cookie fixtures. `session` is what getSessionUser()
   would have resolved to for this request. */
const decide = async (env: Record<string, string | undefined>, h: Record<string, string>, session = false) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const d = await authorizeTxnRequest(hdrs(h), async () => session);
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return d;
};
const ON = { SUPABASE_SERVICE_ROLE_KEY: "test-key", TXN_DRILLDOWN_ENABLED: "true", TXN_DRILLDOWN_TOKEN: "test-token-not-a-real-secret" };
type Decision = Awaited<ReturnType<typeof authorizeTxnRequest>>;
const st = (d: Decision) => (d.ok ? 200 : d.status);
const cd = (d: Decision) => (d.ok ? "ok:" + d.via : d.code);
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", host: "app.example", origin: "https://app.example" };

{
  let d = await decide({ ...ON, SUPABASE_SERVICE_ROLE_KEY: undefined }, {});
  ok(st(d) === 503, "no service_role key -> 503", cd(d));

  d = await decide({ ...ON, TXN_DRILLDOWN_ENABLED: undefined }, { "sec-fetch-site": "same-origin" });
  ok(st(d) === 403, "drill-down off by default -> 403", cd(d));

  d = await decide(ON, {});
  ok(st(d) === 401, "bare request, no headers -> 401", cd(d));

  d = await decide(ON, { "sec-fetch-site": "cross-site", origin: "https://evil.example" });
  ok(st(d) === 403, "cross-site fetch -> 403", cd(d));

  d = await decide(ON, { "sec-fetch-site": "same-origin", host: "app.example", origin: "https://evil.example" });
  ok(st(d) === 403, "same-origin claim with foreign Origin -> 403", cd(d));

  d = await decide(ON, { authorization: "Bearer wrong" });
  ok(st(d) === 401, "wrong bearer token -> 401", cd(d));

  d = await decide({ ...ON, TXN_DRILLDOWN_TOKEN: undefined }, { "x-drilldown-token": "anything" });
  ok(st(d) === 401, "token presented but none configured -> 401", cd(d));

  d = await decide(ON, { "x-drilldown-token": "test-token-not-a-real-secret" });
  ok(st(d) === 200, "correct token -> allowed (no session needed)", cd(d));

  /* The Supabase session replaces the old Vercel Deployment Protection cookie.
     That gate keyed on Vercel team membership, and was never satisfied on the
     production alias, so it failed closed for every real user. */
  d = await decide(ON, SAME_ORIGIN, false);
  ok(st(d) === 401 && cd(d) === "no_session", "first-party fetch with no session -> 401", cd(d));

  d = await decide(ON, SAME_ORIGIN, true);
  ok(st(d) === 200, "first-party fetch with a session -> allowed", cd(d));
}

// --- 5. live aggregates (read-only) -----------------------------------------
//
// Reads with the service_role key, falling back to the publishable key. The
// publishable key alone stopped working here once 0005_auth_rls.sql moved these
// tables from anon to authenticated — which is the whole point of that
// migration, and is asserted directly by verify/anon-lockout.mts. This script
// is operator-run against .env.local, so service_role is the right key for it.

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
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  fileEnv.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  fileEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

type Agg = { facility: string; posted_period: string; kpi_group: string; amount: string; n: number };
let live: Agg[] = [];
if (SB_URL && SB_KEY) {
  const res = await fetch(`${SB_URL}/rest/v1/agg_group_month?select=facility,posted_period,kpi_group,amount,n&limit=5000`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  live = res.ok ? ((await res.json()) as Agg[]) : [];
  console.log("\n== live agg_group_month (publishable key, read-only) ==");
  console.log("rows              :", live.length, "grand total $" + live.reduce((s, r) => s + Number(r.amount), 0).toFixed(2));
} else {
  console.log("\n(no NEXT_PUBLIC_SUPABASE_* found — skipping the live comparison)");
}
const liveKey = (f: string, p: string, g: string) => `${f}|${p}|${g}`;
const liveMap = new Map(live.map((r) => [liveKey(r.facility, r.posted_period, r.kpi_group), r]));

// Every fixture slice must equal the live aggregate row, to the penny.
if (live.length) {
  let mism = 0;
  for (const a of ing.aggGroupMonth) {
    const l = liveMap.get(liveKey(a.facility, a.posted_period, a.kpi_group));
    if (!l || Number(l.amount).toFixed(2) !== a.amount.toFixed(2) || l.n !== a.n) mism++;
  }
  ok(mism === 0 && live.length === ing.aggGroupMonth.length,
    `all ${ing.aggGroupMonth.length} fixture (facility, month, group) slices match live agg_group_month`,
    `mismatches=${mism}, live rows=${live.length}`);
}

// --- 6. THE PROOF: drilled rows sum to the displayed aggregate --------------

console.log("\n== drilled rows vs agg_group_month ==");
const samples: [string, string, string][] = [
  ["Hillside", "2026-07", "Payroll Expenses"],
  ["Opus Health", "2026-06", "Cost of Goods Sold"],
  ["Revival MH", "2026-08", "Advertising & Marketing"],
  ["Lonestar", "2026-04", "Contract Labor"],
  ["Houston Mental Health", "2026-05", "General Business Expenses"],
  ["Pacific MH", "2026-06", "IT Expense"],
];

console.log(
  ["facility", "month", "kpi_group", "agg $", "drilled $", "agg n", "drilled n", "pages"].join("\t"),
);
for (const [facility, month, kpi_group] of samples) {
  const p = parse(`facility=${encodeURIComponent(facility)}&month=${month}&kpi_group=${encodeURIComponent(kpi_group)}&limit=100`);
  if (!p.ok) { ok(false, `${facility} / ${month} / ${kpi_group}: params rejected`, p.code); continue; }

  const first = await fetchTxnPage(db, p.filters);
  // Walk every page and re-sum from the rows the UI would actually render.
  let pageSumCents = 0;
  let pages = 0;
  const seen = new Set<string>();
  for (let off = 0; off < first.totals.count; off += p.filters.limit) {
    const pg = await fetchTxnPage(db, { ...p.filters, offset: off } as TxnFilters);
    pages++;
    for (const r of pg.rows) {
      pageSumCents += Math.round(r.amount * 100);
      seen.add(`${r.row_key}:${r.occurrence}`);
    }
  }
  const liveRow = liveMap.get(liveKey(facility, `${month}-01`, kpi_group));
  const aggAmt = liveRow ? Number(liveRow.amount) : NaN;
  const drilled = first.totals.amount ?? NaN;
  console.log([
    facility, month, kpi_group,
    Number.isNaN(aggAmt) ? "n/a" : aggAmt.toFixed(2),
    drilled.toFixed(2),
    liveRow ? liveRow.n : "n/a",
    first.totals.count,
    pages,
  ].join("\t"));

  ok(!!liveRow, `live aggregate row exists for ${facility} / ${month} / ${kpi_group}`);
  if (liveRow) {
    ok(drilled.toFixed(2) === aggAmt.toFixed(2), `  route total == agg_group_month.amount`, `${drilled.toFixed(2)} vs ${aggAmt.toFixed(2)}`);
    ok(first.totals.count === liveRow.n, `  route row count == agg_group_month.n`, `${first.totals.count} vs ${liveRow.n}`);
    ok(pageSumCents === Math.round(aggAmt * 100), `  sum of every paged row == agg amount`, `${(pageSumCents / 100).toFixed(2)} vs ${aggAmt.toFixed(2)}`);
    ok(seen.size === first.totals.count, `  paging returned each (row_key, occurrence) exactly once`, `${seen.size} of ${first.totals.count}`);
  }
}

// --- 7. cap / truncation honesty -------------------------------------------

console.log("\n== cap, pagination and truncation reporting ==");
{
  const p = parse("facility=Opus%20Health&month=2026-06&kpi_group=Cost%20of%20Goods%20Sold&limit=100");
  if (p.ok) {
    const page = await fetchTxnPage(db, p.filters);
    ok(page.rows.length === 100, "page respects the requested limit", String(page.rows.length));
    ok(page.truncated === true, "truncated flag set when the page is smaller than the population");
    ok(page.totals.count > page.rows.length, "true row count exceeds the page", `${page.totals.count} > ${page.rows.length}`);
    ok(page.totals.exact === true && page.totals.amount !== null, "true total is reported alongside the truncated page", "$" + page.totals.amount!.toFixed(2));
    const partial = page.rows.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
    ok(Math.abs(partial - page.totals.amount!) > 0.01, "page subtotal differs from the true total (so the UI must, and does, say so)", `$${partial.toFixed(2)} vs $${page.totals.amount!.toFixed(2)}`);

    const last = await fetchTxnPage(db, { ...p.filters, offset: Math.floor((page.totals.count - 1) / 100) * 100 });
    ok(last.rows.length > 0 && last.rows.length <= 100, "last page is short and non-empty", String(last.rows.length));
  }
}
{
  // deepest legal page never exceeds the cap
  const p = parse("month=2026-06&limit=500&offset=20000");
  ok(p.ok, "limit=500 offset=20000 is the documented ceiling and is accepted");
}
{
  // month-only drill: whole month, all facilities, all groups
  const p = parse("month=2026-06");
  if (p.ok) {
    const page = await fetchTxnPage(db, p.filters);
    const fixtureMonth = ing.factRows.filter((r) => r.posted_period === "2026-06-01");
    const expect = fixtureMonth.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
    ok(page.totals.count === fixtureMonth.length, "month-only drill counts every row in the month", `${page.totals.count} vs ${fixtureMonth.length}`);
    ok(page.totals.amount!.toFixed(2) === expect.toFixed(2), "month-only drill totals every row in the month", `$${page.totals.amount!.toFixed(2)}`);
    const liveMonth = live.filter((r) => r.posted_period === "2026-06-01").reduce((s, r) => s + Number(r.amount), 0);
    if (live.length) ok(page.totals.amount!.toFixed(2) === liveMonth.toFixed(2), "month-only drill == live agg_group_month for that month", `$${liveMonth.toFixed(2)}`);
  }
}
{
  // identical transactions must stay distinct rows
  const dupes = new Map<string, number>();
  for (const r of ing.factRows) dupes.set(r.row_key, (dupes.get(r.row_key) || 0) + 1);
  const repeated = [...dupes.entries()].filter(([, n]) => n > 1);
  if (repeated.length) {
    const [rk, n] = repeated[0];
    const target = ing.factRows.find((r) => r.row_key === rk)!;
    const p = parse(`facility=${encodeURIComponent(target.facility)}&month=${target.posted_period.slice(0, 7)}&kpi_group=${encodeURIComponent(target.kpi_group)}&limit=500`);
    if (p.ok) {
      const all: string[] = [];
      const head = await fetchTxnPage(db, p.filters);
      for (let off = 0; off < head.totals.count; off += 500) {
        const pg = await fetchTxnPage(db, { ...p.filters, offset: off });
        pg.rows.filter((r) => r.row_key === rk).forEach((r) => all.push(`${r.row_key}:${r.occurrence}`));
      }
      ok(all.length === n, `identical transactions stay ${n} distinct rows (row_key ${rk})`, all.join(", "));
    }
  } else {
    console.log("SKIP  no repeated row_key in this export (max occurrence 0)");
  }
}
{
  // vendor + account drills
  const v = ing.aggVendor[0];
  const p = parse(`vendor=${encodeURIComponent(v.vendor)}&kpi_group=${encodeURIComponent(v.kpi_group)}&facility=${encodeURIComponent(v.facility)}`);
  if (p.ok) {
    const page = await fetchTxnPage(db, p.filters);
    ok(page.totals.count === v.n && page.totals.amount!.toFixed(2) === v.amount.toFixed(2),
      `vendor drill matches agg_vendor (${v.vendor.slice(0, 28)})`, `${page.totals.count}/${v.n} rows, $${page.totals.amount!.toFixed(2)}/$${v.amount.toFixed(2)}`);
  }
  const a = ing.aggAccount.slice().sort((x, y) => y.n - x.n)[0];
  const pa = parse(`account_label=${encodeURIComponent(a.account_label)}`);
  if (pa.ok) {
    const page = await fetchTxnPage(db, pa.filters);
    ok(page.totals.count === a.n && page.totals.amount!.toFixed(2) === a.amount.toFixed(2),
      `account drill matches agg_account (${a.account_label.slice(0, 28)})`, `${page.totals.count}/${a.n} rows, $${page.totals.amount!.toFixed(2)}/$${a.amount.toFixed(2)}`);
  }
}

// --- Ramp drills reconcile ---------------------------------------------------
// The Card Spend page shows a cardholder's total from agg_ramp_person
// and then offers a drill; if those two ever disagreed, the panel would be
// quietly wrong about a named person's spending. Asserted here against the
// fixture, and again against the live warehouse in verify/ramp.mts.
console.log("\n== ramp drills ==");
{
  const rampTotalCents = rampFixture.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  ok(rampFixture.length > 0, "the export contains Ramp charges", `${rampFixture.length} rows`);

  const p = parse("ramp=1&month=2026-07");
  if (p.ok) {
    const page = await fetchTxnPage(db, p.filters);
    const want = rampFixture.filter((r) => String(r.posted_period).slice(0, 7) === "2026-07");
    ok(page.totals.count === want.length,
      "ramp + month drill counts exactly the Ramp rows in that month", `${page.totals.count} vs ${want.length}`);
    ok(Math.round(page.totals.amount! * 100) === want.reduce((s, r) => s + Math.round(r.amount * 100), 0),
      "ramp + month drill totals exactly those rows", `$${page.totals.amount!.toFixed(2)}`);
  }

  // Biggest cardholder, since that is the row a user is most likely to open.
  const byPerson = new Map<string, { cents: number; n: number }>();
  for (const r of rampFixture) {
    const cur = byPerson.get(r.ramp_cardholder) ?? { cents: 0, n: 0 };
    cur.cents += Math.round(r.amount * 100);
    cur.n += 1;
    byPerson.set(r.ramp_cardholder, cur);
  }
  const [person, want] = [...byPerson.entries()].sort((a, b) => b[1].cents - a[1].cents)[0];
  const pp = parse(`person=${encodeURIComponent(person)}&limit=500`);
  if (pp.ok) {
    const page = await fetchTxnPage(db, pp.filters);
    ok(page.totals.count === want.n, `cardholder drill counts every charge (${person})`, `${page.totals.count} vs ${want.n}`);
    ok(Math.round(page.totals.amount! * 100) === want.cents,
      "cardholder drill totals exactly their charges", `$${(want.cents / 100).toFixed(2)}`);
    ok(page.rows.every((r) => isRampSplit(r.split)),
      "every row returned for a cardholder is a Ramp charge — the implication holds through the query");
  }

  // Every cardholder's share must add back up to the whole. If normalisation
  // dropped or merged someone, this is where it shows.
  const sumOfPeople = [...byPerson.values()].reduce((s, v) => s + v.cents, 0);
  ok(sumOfPeople === rampTotalCents,
    "every cardholder's spend sums back to the whole Ramp slice",
    `$${(sumOfPeople / 100).toFixed(2)} vs $${(rampTotalCents / 100).toFixed(2)}`);
  ok(!byPerson.has(""), "normalisation never produces an empty cardholder name");
}

// --- 8. empty fact_txn (today's production state) ---------------------------

console.log("\n== empty fact_txn (current production state) ==");
{
  const p = parse("facility=Hillside&month=2026-07&kpi_group=Payroll%20Expenses");
  if (p.ok) {
    const page = await fetchTxnPage(emptyDb, p.filters);
    ok(page.totals.count === 0 && page.totals.amount === 0 && page.rows.length === 0, "empty table yields zero rows and a zero total");
    ok(page.detail_available === false, "detail_available=false so the UI can say 'no detail loaded yet' rather than '$0'");
    ok(page.truncated === false, "nothing is reported as truncated");
  }
  const withRows = await fetchTxnPage(db, (parse("facility=Hillside&month=2026-07&kpi_group=Advertising%20%26%20Marketing") as any).filters);
  ok(withRows.detail_available === true, "detail_available=true once fact_txn holds rows");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
