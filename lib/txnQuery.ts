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

export const TXN_COLUMNS =
  "row_key,occurrence,facility,txn_date,posted_period,txn_type,num,name,description,split,account_num,account_label,kpi_group,kind,amount";

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
  limit: number;
  offset: number;
  sort: SortKey;
  dir: "asc" | "desc";
};

export type Allowlists = {
  facilities: Set<string>;
  groups: Set<string>;
  accounts: Set<string>;
  vendors: Set<string>;
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

  if (!facility && !month && !kpi_group && !account_label && !vendor)
    return bad(
      "filter_required",
      "At least one of facility, month, kpi_group, account_label or vendor is required — transaction detail is not dumped unfiltered.",
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

  return {
    ok: true,
    filters: {
      facility,
      month,
      kpi_group,
      account_label,
      vendor,
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

  // True total for the whole filter. PostgREST cannot SUM without an RPC (and
  // this PR adds no DDL), so page a single numeric column and add it up in
  // integer cents — no float drift, exact to the penny.
  let amount: number | null = null;
  let exact = false;
  if (count === 0) {
    amount = 0;
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

export async function loadAllowlists(db: TxnDb, now = Date.now()): Promise<Allowlists> {
  if (allowCache && now - allowCache.at < ALLOW_TTL_MS) return allowCache.value;

  const [facs, accts, vends] = await Promise.all([
    db.from("dim_facility").select("facility").range(0, 999),
    db.from("agg_account").select("account_label").range(0, 4999),
    db.from("agg_vendor").select("vendor").range(0, 4999),
  ]);
  for (const r of [facs, accts, vends]) if (r.error) throw new TxnQueryError(r.error.message);

  const value: Allowlists = {
    facilities: new Set((facs.data || []).map((r) => String(r.facility))),
    groups: new Set(KPI_GROUPS),
    accounts: new Set((accts.data || []).map((r) => String(r.account_label))),
    vendors: new Set([...(vends.data || []).map((r) => String(r.vendor)), NO_PAYEE]),
  };
  allowCache = { at: now, value };
  return value;
}

/** Test seam: drop the whitelist cache. */
export function resetAllowlistCache(): void {
  allowCache = null;
}
