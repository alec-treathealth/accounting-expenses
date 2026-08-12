/* Contract tests for drill-down search.
 *
 * Search is the only filter value in /api/txn that is NOT drawn from an
 * allowlist, and it is interpolated into a PostgREST `or=` filter string where
 * "," separates conditions, "(" / ")" group them and "*" is the ilike wildcard.
 * A term carrying those characters could change the filter's MEANING rather
 * than just its text. These cases pin that boundary, plus the two behaviours a
 * financial drill-down depends on: search must never widen a drill, and it must
 * never be able to stand in for a filter.
 *
 * Pure functions and a recording stub — no database, no CSV, runs in ms.
 */

import {
  MAX_Q,
  Q_COLUMNS,
  parseTxnParams,
  sanitizeQ,
  fetchTxnPage,
  type Allowlists,
  type TxnFilters,
} from "../lib/txnQuery.ts";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const ALLOW: Allowlists = {
  facilities: new Set(["Hillside"]),
  groups: new Set(["Payroll Expenses"]),
  accounts: new Set(["6165 Employee Laboratory or Medical Visit Expense"]),
  vendors: new Set(["Anchor Family Therapy"]),
};
const sp = (o: Record<string, string>) => new URLSearchParams(o);

console.log("== sanitizeQ: structural characters cannot survive ==");
for (const ch of [",", "(", ")", "*", '"', "\\", "%", "_"]) {
  const out = sanitizeQ(`a${ch}b`);
  check(`strips ${JSON.stringify(ch)}`, !out.includes(ch), `got ${JSON.stringify(out)}`);
}
eq("collapses whitespace and trims", sanitizeQ("  Anchor   Family  "), "Anchor Family");
eq("keeps characters real payees use", sanitizeQ("St. Louis & Co-op #4/A+"), "St. Louis & Co-op #4/A+");
check("caps length", sanitizeQ("x".repeat(400)).length === MAX_Q, `len=${sanitizeQ("x".repeat(400)).length}`);
eq("punctuation-only term becomes empty", sanitizeQ("(),*"), "");

console.log("\n== parseTxnParams ==");
const alone = parseTxnParams(sp({ q: "anchor" }), ALLOW);
check(
  "search ALONE is refused — it must not become an unfiltered table scan",
  !alone.ok && alone.code === "filter_required",
  !alone.ok ? alone.code : "unexpectedly ok",
);

const scoped = parseTxnParams(sp({ facility: "Hillside", q: "anchor" }), ALLOW);
check("search alongside a real filter is accepted", scoped.ok);
if (scoped.ok) eq("term is carried through", scoped.filters.q, "anchor");

const dirty = parseTxnParams(sp({ facility: "Hillside", q: "anchor,amount.gt.0" }), ALLOW);
check(
  "an injected PostgREST condition is neutralised, not passed through",
  dirty.ok && !dirty.filters.q!.includes(","),
  dirty.ok ? `q=${JSON.stringify(dirty.filters.q)}` : "parse failed",
);

const emptied = parseTxnParams(sp({ facility: "Hillside", q: "()," }), ALLOW);
check(
  "a term that sanitizes to nothing is treated as absent, not as an error",
  emptied.ok && emptied.filters.q === null,
  emptied.ok ? `q=${JSON.stringify(emptied.filters.q)}` : "parse failed",
);

console.log("\n== the filter actually sent to PostgREST ==");
/* Records every filter call so the composed query can be asserted, then returns
   an empty page. fetchTxnPage is driven for real, so this exercises the same
   applyFilters used by the page read AND the total read. */
function recorder() {
  const calls: string[] = [];
  const builder: any = {
    eq: (c: string, v: unknown) => (calls.push(`eq:${c}=${String(v)}`), builder),
    or: (s: string) => (calls.push(`or:${s}`), builder),
    order: () => builder,
    range: () => builder,
    select: () => builder,
    then: (res: (v: any) => unknown) => res({ data: [], error: null, count: 0 }),
  };
  return { calls, db: { from: () => builder } };
}

const base: TxnFilters = {
  facility: "Hillside", month: null, kpi_group: null, account_label: null,
  vendor: null, q: null, limit: 10, offset: 0, sort: "txn_date", dir: "asc",
};

const clean = recorder();
await fetchTxnPage(clean.db as any, { ...base, q: "anchor" });
const orCalls = clean.calls.filter((c) => c.startsWith("or:"));
check("search emits exactly one or= filter", orCalls.length === 1, orCalls.join(" | "));
eq(
  "it covers every search column, wildcarded, and nothing else",
  orCalls[0],
  `or:${Q_COLUMNS.map((c) => `${c}.ilike.*anchor*`).join(",")}`,
);
check(
  "the facility scope is still applied — search narrows, never replaces",
  clean.calls.includes("eq:facility=Hillside"),
  clean.calls.join(" | "),
);

const none = recorder();
await fetchTxnPage(none.db as any, base);
check(
  "no search term emits no or= filter at all",
  !none.calls.some((c) => c.startsWith("or:")),
  none.calls.join(" | "),
);

/* The whole point of sanitizing: prove a hostile term cannot add a condition.
   ",amount.gt.0" would otherwise become a second or= branch and WIDEN the
   result set past the drilled slice. */
const hostile = recorder();
await fetchTxnPage(hostile.db as any, { ...base, q: sanitizeQ("x,amount.gt.0") });
const hostileOr = hostile.calls.find((c) => c.startsWith("or:")) ?? "";
const branches = hostileOr.slice(3).split(",");
check(
  "a hostile term yields exactly the expected branch count (no extra condition)",
  branches.length === Q_COLUMNS.length,
  `${branches.length} branches: ${hostileOr}`,
);
check(
  "every branch is an ilike on a known search column",
  branches.every((b) => Q_COLUMNS.some((c) => b.startsWith(`${c}.ilike.*`))),
  hostileOr,
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures) process.exit(1);
