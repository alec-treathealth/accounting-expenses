import { GROUP_ORDER } from "./classify";

// ---------------------------------------------------------------------------
// Filter validation + paged read of fact_txn for the dashboard drill-down.
//
// Rules this module enforces, on the server, for every request:
//   * at least one filter is required — there is no "select everything" path;
//   * every filter value is checked against a whitelist (facility / kpi_group /
//     account_label / vendor come from the aggregate tables, month from a
//     regex), so nothing user-supplied reaches PostgREST unbounded;
//   * a page is hard-capped at MAX_LIMIT rows and MAX_OFFSET deep;
//   * alongside the page it returns the TRUE total amount and TRUE row count
//     for the whole filter, so a truncated page can never be mistaken for the
//     full population (financial invariant: drilled rows must sum to the KPI).
//
// Transaction identity is (row_key, occurrence). Rows are never de-duplicated
// and never grouped — two legitimately identical transactions stay two rows.
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const MAX_OFFSET = 20_000;
/** Chunk size when summing the full filtered population. */
export const SUM_CHUNK = 1000;
/** Refuse to scan more than this many rows for an exact total. */
export const SUM_SCAN_CAP = 200_000;

export const NO_PAYEE = "(no payee)";

/* is_ramp and ramp_cardholder are the PostgREST computed columns from migration
   0010, selected explicitly here so each returned row carries the cardholder the
   DATABASE derived. The drawer links a description through to Expense
   Intelligence, and doing that from a client-side re-implementation of
   ramp_person() would put a second definition of "who" in the codebase — the one
   thing this feature has avoided since it was built. */
export const TXN_COLUMNS =
  "row_key,occurrence,facility,txn_date,posted_period,txn_type,num,name,description,split,account_num,account_label,kpi_group,kind,amount,is_ramp,ramp_cardholder";

export const SORT_KEYS = ["txn_date", "amount", "name", "account_label"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const KPI_GROUPS: readonly string[] = [...GROUP_ORDER, "Unmapped"];

export type TxnFilters = {
  facility: string | null;
  /** "YYYY-MM" */
  month: string | null;
  kpi_group: string | null;
  account_label: string | null;
  vendor: string | null;
  /** Restrict to Ramp card charges. NOT a filter for filter_required purposes. */
  ramp: boolean;
  /** Ramp cardholder, as public.ramp_person() derives it from the description. */
  person: string | null;
  /** Free-text search over payee / description / account, already sanitized. */
  q: string | null;
  limit: number;
  offset: number;
  sort: SortKey;
  dir: "asc" | "desc";
};

/* PostgREST computed columns on fact_txn (supabase/migrations/0010). Filtering
   through these rather than through `split ilike '2030 Ramp*'` is what keeps the
   PAGE query and the TOTALS query using ONE definition — see the migration for
   why a hand-written equivalent is not good enough. */
export const RAMP_COL = "is_ramp";
export const PERSON_COL = "ramp_cardholder";

/** Longest accepted search term. Bounded because it is the only filter value
 *  that is not drawn from an allowlist. */
export const MAX_Q = 64;

/* Search columns. `description` and `name` are what a human recognises; the
   account label is included so "6165" or "laboratory" finds its rows. */
export const Q_COLUMNS = ["name", "description", "account_label"] as const;

/* Every other filter value is checked against an allowlist built from the
   aggregate tables, so it cannot be anything the warehouse does not already
   contain. A search term cannot work that way, so it is sanitized instead.
   This is NOT cosmetic: the term is interpolated into a PostgREST `or=` filter
   string, where "," separates conditions, "(" / ")" group them and "*" is the
   ilike wildcard. A term containing those could change the filter's MEANING
   rather than just its text — filter injection, the REST equivalent of SQL
   injection. So the value is reduced to a conservative character class,
   collapsed, and length-capped, and the sanitized form is echoed back to the
   client so the UI can show what was actually searched rather than what was
   typed. */
export function sanitizeQ(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9 &'\-./#+]/g, " ") // drop , ( ) " \ * % _ and friends
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_Q);
}

export type Allowlists = {
  facilities: Set<string>;
  groups: Set<string>;
  accounts: Set<string>;
  vendors: Set<string>;
  /** Cardholders, from agg_ramp_person — the only place person names are enumerated. */
  people: Set<string>;
};

export type ParseResult =
  | { ok: true; filters: TxnFilters }
  | { ok: false; code: string; message: string };

const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;
const PERIOD_RE = /^(20\d{2}-(?:0[1-9]|1[0-2]))-01$/;

function one(sp: URLSearchParams, key: string): string | null {
  const v = sp.get(key);
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function intParam(
  sp: URLSearchParams,
  key: string,
  dflt: number,
  min: number,
  max: number,
): number | null {
  const raw = one(sp, key);
  if (raw === null) return dflt;
  if (!/^\d{1,7}$/.test(raw)) return null;
  const n = Number(raw);
  if (n < min || n > max) return null;
  return n;
}

export function parseTxnParams(sp: URLSearchParams, allow: Allowlists): ParseResult {
  const bad = (code: string, message: string): ParseResult => ({ ok: false, code, message });

  const facility = one(sp, "facility");
  if (facility !== null && !allow.facilities.has(facility)) return bad("bad_facility", "Unknown facility.");

  // Accept either month=YYYY-MM or posted_period=YYYY-MM-01.
  let month = one(sp, "month");
  const period = one(sp, "posted_period");
  if (month === null && period !== null) {
    const m = period.match(PERIOD_RE);
    if (!m) return bad("bad_period", "posted_period must be the first of a month (YYYY-MM-01).");
    month = m[1];
  }
  if (month !== null && !MONTH_RE.test(month)) return bad("bad_month", "month must be YYYY-MM.");

  const kpi_group = one(sp, "kpi_group");
  if (kpi_group !== null && !allow.groups.has(kpi_group)) return bad("bad_kpi_group", "Unknown KPI group.");

  const account_label = one(sp, "account_label");
  if (account_label !== null && !allow.accounts.has(account_label))
    return bad("bad_account_label", "Unknown account.");

  const vendor = one(sp, "vendor");
  if (vendor !== null && !allow.vendors.has(vendor)) return bad("bad_vendor", "Unknown vendor.");

  const person = one(sp, "person");
  if (person !== null && !allow.people.has(person)) return bad("bad_person", "Unknown cardholder.");

  /* Ramp restriction. Accepts only the two forms the client sends; anything else
     is a caller error rather than a silent false, so a typo'd `ramp=yes` fails
     loudly instead of quietly widening the drill to every transaction.

     A person IMPLIES ramp, and that implication lives HERE — in the one place
     that produces the filter set — rather than in applyFilters(). It has to:
     applyFilters() builds the page query and txn_totals() computes the figure
     the page is checked against, so an implication applied in only one of them
     would make the drawer report "does not reconcile" against itself. Cardholder
     names are derived from Ramp descriptions and mean nothing off a Ramp row. */
  const rampRaw = one(sp, "ramp");
  if (rampRaw !== null && rampRaw !== "1" && rampRaw !== "true")
    return bad("bad_ramp", "ramp must be 1 or true.");
  const ramp = rampRaw !== null || person !== null;

  /* `ramp` is deliberately NOT in this set. On its own it selects 24,226 rows —
     81% of the warehouse — which is exactly the unfiltered dump this rule
     exists to prevent. `person` IS in the set: it names one cardholder, and the
     largest of them is 3,606 rows. */
  if (!facility && !month && !kpi_group && !account_label && !vendor && !person)
    return bad(
      "filter_required",
      "At least one of facility, month, kpi_group, account_label, vendor or person is required — transaction detail is not dumped unfiltered.",
    );

  const limit = intParam(sp, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (limit === null) return bad("bad_limit", `limit must be an integer between 1 and ${MAX_LIMIT}.`);
  const offset = intParam(sp, "offset", 0, 0, MAX_OFFSET);
  if (offset === null) return bad("bad_offset", `offset must be an integer between 0 and ${MAX_OFFSET}.`);

  const sortRaw = one(sp, "sort") || "txn_date";
  if (!(SORT_KEYS as readonly string[]).includes(sortRaw))
    return bad("bad_sort", `sort must be one of ${SORT_KEYS.join(", ")}.`);
  const dirRaw = (one(sp, "dir") || "asc").toLowerCase();
  if (dirRaw !== "asc" && dirRaw !== "desc") return bad("bad_dir", "dir must be asc or desc.");

  /* Search is deliberately NOT part of the filter_required set above. A term on
     its own would make `?q=a` a full-table scan of transaction detail, which is
     the exact thing that rule exists to prevent. It can only narrow a drill
     that is already scoped by facility / month / group / account / vendor.
     A term that sanitizes down to nothing (e.g. only punctuation) is treated as
     absent rather than as an error — it would match everything anyway. */
  const qRaw = one(sp, "q");
  const q = qRaw ? sanitizeQ(qRaw) || null : null;

  return {
    ok: true,
    filters: {
      facility,
      month,
      kpi_group,
      account_label,
      vendor,
      ramp,
      person,
      q,
      limit,
      offset,
      sort: sortRaw as SortKey,
      dir: dirRaw,
    },
  };
}

// --- minimal structural view of the PostgREST client we need ----------------
// The route passes the real service_role client; the fixture harness passes an
// in-memory stand-in, so the exact same query-building code is exercised.

export type PgResult = { data: any[] | null; error: { message: string } | null; count: number | null };

export interface PgBuilder extends PromiseLike<PgResult> {
  eq(column: string, value: unknown): PgBuilder;
  or(filter: string): PgBuilder;
  order(column: string, opts?: { ascending?: boolean }): PgBuilder;
  range(from: number, to: number): PgBuilder;
}

export interface TxnDb {
  from(table: string): {
    select(columns: string, opts?: { count?: "exact"; head?: boolean }): PgBuilder;
  };
  /** Optional: present on a real Supabase client, absent on the in-memory test
   *  fixture. fetchTxnPage uses it for the fast exact-total path and falls back
   *  to chunked paging when it is missing, so the offline harness still runs. */
  rpc?(fn: string, args?: Record<string, unknown>): PromiseLike<PgResult>;
}

export type TxnRow = {
  row_key: string;
  occurrence: number;
  facility: string;
  txn_date: string;
  posted_period: string;
  txn_type: string | null;
  num: string | null;
  name: string | null;
  description: string | null;
  split: string | null;
  account_num: string | null;
  account_label: string;
  kpi_group: string;
  kind: string | null;
  amount: number;
  /** Computed columns — see TXN_COLUMNS. */
  is_ramp?: boolean;
  ramp_cardholder?: string | null;
};

export type TxnPage = {
  rows: TxnRow[];
  page: { limit: number; offset: number; returned: number };
  /** True figures for the WHOLE filter, not just this page. */
  totals: { amount: number | null; count: number; exact: boolean };
  truncated: boolean;
  /** false => fact_txn holds no rows at all (detail never loaded). */
  detail_available: boolean;
};

function applyFilters(q: PgBuilder, f: TxnFilters): PgBuilder {
  if (f.facility) q = q.eq("facility", f.facility);
  if (f.month) q = q.eq("posted_period", `${f.month}-01`);
  if (f.kpi_group) q = q.eq("kpi_group", f.kpi_group);
  if (f.account_label) q = q.eq("account_label", f.account_label);
  if (f.vendor) q = f.vendor === NO_PAYEE ? q.or("name.is.null,name.eq.") : q.eq("name", f.vendor);
  /* Computed columns, so this predicate IS public.is_ramp_split() and
     public.ramp_person() rather than a re-implementation of them. The
     person-implies-ramp rule was already applied in parseTxnParams, so this
     reads the flags plainly. */
  if (f.ramp) q = q.eq(RAMP_COL, true);
  if (f.person) q = q.eq(PERSON_COL, f.person);
  // Search LAST so it narrows the scoped set rather than replacing it: a drill
  // into (Hillside, July, Payroll) that is then searched must stay inside that
  // slice. Because this function feeds BOTH the page read and the total read in
  // fetchTxnPage, the reported total automatically describes the searched
  // subset — the two can never disagree.
  if (f.q) q = q.or(Q_COLUMNS.map((c) => `${c}.ilike.*${f.q}*`).join(","));
  return q;
}

/** Stable order so paging can neither skip nor repeat a row. */
function applyOrder(q: PgBuilder, sort: SortKey, ascending: boolean): PgBuilder {
  return q
    .order(sort, { ascending })
    .order("row_key", { ascending: true })
    .order("occurrence", { ascending: true });
}

const toCents = (v: unknown) => Math.round(Number(v) * 100);

export class TxnQueryError extends Error {}

export async function fetchTxnPage(db: TxnDb, f: TxnFilters): Promise<TxnPage> {
  const asc = f.dir === "asc";

  const pageRes = await applyOrder(
    applyFilters(db.from("fact_txn").select(TXN_COLUMNS, { count: "exact" }), f),
    f.sort,
    asc,
  ).range(f.offset, f.offset + f.limit - 1);
  if (pageRes.error) throw new TxnQueryError(pageRes.error.message);

  const rows: TxnRow[] = (pageRes.data || []).map((r) => ({ ...r, amount: Number(r.amount) }) as TxnRow);
  const count = pageRes.count ?? rows.length;

  // True total for the whole filter.
  //
  // Fast path: public.txn_totals() does count+sum server-side in ONE round trip.
  // The fallback below pages the whole population in SUM_CHUNK-row slices, and
  // those reads are SEQUENTIAL, so its cost scales with the slice: "Cost of Goods
  // Sold" (18,841 rows) took 19 round trips, a month 8, a big facility 5, while
  // the aggregate itself runs in ~3ms. The fallback is kept because the in-memory
  // fixture in verify/txn-drilldown.mts has no .rpc(), and it stays correct — just
  // slower — if the function is ever missing from a database.
  let amount: number | null = null;
  let exact = false;
  if (count === 0) {
    amount = 0;
    exact = true;
  } else if (typeof db.rpc === "function") {
    const res = await db.rpc("txn_totals", {
      p_facility: f.facility,
      p_posted_period: f.month ? `${f.month}-01` : null,
      p_kpi_group: f.kpi_group,
      p_account_label: f.account_label,
      p_vendor: f.vendor === NO_PAYEE ? null : f.vendor,
      p_no_payee: f.vendor === NO_PAYEE,
      p_q: f.q,
      p_ramp: f.ramp,
      p_person: f.person,
    });
    if (res.error) throw new TxnQueryError(res.error.message);
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row) throw new TxnQueryError("txn_totals returned no row");
    // Round through integer cents, matching the chunked path exactly.
    amount = toCents(row.total_amount) / 100;
    exact = true;
  } else if (count <= SUM_SCAN_CAP) {
    let total = 0;
    for (let from = 0; from < count; from += SUM_CHUNK) {
      const chunk = await applyOrder(
        applyFilters(db.from("fact_txn").select("amount"), f),
        "txn_date",
        true,
      ).range(from, Math.min(from + SUM_CHUNK, count) - 1);
      if (chunk.error) throw new TxnQueryError(chunk.error.message);
      const got = chunk.data || [];
      for (const r of got) total += toCents(r.amount);
      if (!got.length) break; // population shrank mid-read; stop rather than spin
    }
    amount = total / 100;
    exact = true;
  }

  // Distinguish "no detail loaded yet" from "no rows match this filter".
  let detail_available = count > 0;
  if (count === 0) {
    const probe = await db.from("fact_txn").select("row_key", { count: "exact", head: true }).range(0, 0);
    if (probe.error) throw new TxnQueryError(probe.error.message);
    detail_available = (probe.count ?? 0) > 0;
  }

  return {
    rows,
    page: { limit: f.limit, offset: f.offset, returned: rows.length },
    totals: { amount, count, exact },
    truncated: rows.length < count,
    detail_available,
  };
}

// --- filter whitelists, read once per process (short TTL) -------------------

const ALLOW_TTL_MS = 5 * 60 * 1000;
let allowCache: { at: number; value: Allowlists } | null = null;

/**
 * Read an entire column, in pages, into a Set.
 *
 * `.range(0, 4999)` DOES NOT read 5,000 rows. PostgREST caps every response at
 * db-max-rows — 1000 on this project — and it applies to the SERVICE ROLE too,
 * silently: no error, no flag, just a short array. agg_vendor holds 4,791 rows
 * covering 2,673 distinct vendors, so the allowlist built from one unpaged read
 * contained 808 of them and every drill-down on the other 1,865 was rejected as
 * `bad_vendor` — including GUSTO NET, Franchise Tax Board and GUSTO TAX, three
 * of the ten largest vendors in the company.
 *
 * STEP BY WHAT CAME BACK AND STOP ONLY ON AN EMPTY PAGE, matching restAll() in
 * verify/supabase.mts. Treating "fewer rows than I asked for" as the end is the
 * exact assumption that produced the truncation in the first place, and it would
 * silently return again if db-max-rows were ever lowered.
 *
 * ORDER IS LOAD-BEARING. Without a total order Postgres may return rows in any
 * order per request, so page 2 can repeat or omit rows from page 1.
 */
async function readColumn(db: TxnDb, table: string, column: string): Promise<string[]> {
  const PAGE = 1000;
  /** Guard against an unbounded loop if a page ever repeats rather than advances. */
  const HARD_CAP = 200_000;
  const out: string[] = [];
  for (let from = 0; from < HARD_CAP; ) {
    const res = await db.from(table).select(column).order(column, { ascending: true }).range(from, from + PAGE - 1);
    if (res.error) throw new TxnQueryError(res.error.message);
    const rows = res.data || [];
    if (!rows.length) break;
    for (const r of rows) out.push(String((r as Record<string, unknown>)[column]));
    from += rows.length;
  }
  return out;
}

export async function loadAllowlists(db: TxnDb, now = Date.now()): Promise<Allowlists> {
  if (allowCache && now - allowCache.at < ALLOW_TTL_MS) return allowCache.value;

  const [facs, accts, vends, people] = await Promise.all([
    readColumn(db, "dim_facility", "facility"),
    readColumn(db, "agg_account", "account_label"),
    readColumn(db, "agg_vendor", "vendor"),
    // The Set dedupes: agg_ramp_person is one row per (facility, month, person,
    // group), so ~1,700 rows collapse to ~100 people. Reading the aggregate
    // rather than fact_txn keeps this a cheap indexed scan and means the
    // allowlist is exactly the set of people the UI can offer.
    readColumn(db, "agg_ramp_person", "person"),
  ]);

  const value: Allowlists = {
    facilities: new Set(facs),
    groups: new Set(KPI_GROUPS),
    accounts: new Set(accts),
    vendors: new Set([...vends, NO_PAYEE]),
    people: new Set(people),
  };
  allowCache = { at: now, value };
  return value;
}

/** Test seam: drop the whitelist cache. */
export function resetAllowlistCache(): void {
  allowCache = null;
}
