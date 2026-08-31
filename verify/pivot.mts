// Asserts the pivot maths against the live agg_group_month. Pivoting must not
// create or lose money: every pairing of dimensions has to reproduce the same
// grand total, and every cell has to equal a direct sum of the rows it covers.
//
//   npm run verify:pivot

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { avgPerFullMonth, cellKey, delta, dimValue, partialMonth, pivot, type AggRow, type Dim } from "../lib/pivot.ts";

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
// service_role: 0005 moved these tables to authenticated-and-invited, so the
// publishable key can no longer read them.
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const res = await fetch(
  `${URL_}/rest/v1/agg_group_month?select=facility,posted_period,kpi_group,amount,n&limit=5000`,
  { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } },
);
if (!res.ok) {
  console.error("could not read agg_group_month:", res.status);
  process.exit(2);
}
const raw = (await res.json()) as any[];
// Match how Dashboard.tsx normalises: month keys are "YYYY-MM".
const rows: AggRow[] = raw.map((r) => ({
  facility: String(r.facility),
  posted_period: String(r.posted_period).slice(0, 7),
  kpi_group: String(r.kpi_group),
  amount: Number(r.amount),
  n: Number(r.n),
}));

const r2 = (x: number) => Math.round(x * 100) / 100;
const GRAND = r2(rows.reduce((s, r) => s + r.amount, 0));
const GRAND_N = rows.reduce((s, r) => s + r.n, 0);

console.log(`source rows: ${rows.length}, grand $${GRAND.toFixed(2)}, n=${GRAND_N}\n`);
/* A deliberate tripwire: it fails whenever the warehouse total moves, so a
   change has to be confirmed rather than absorbed. Update it ONLY alongside an
   approved ingest, and say in the commit what moved.
     29,826,050.36  Aug 31 2026 export through month end (newest
                    fact_txn.loaded_at: 2026-08-31 07:34 UTC). August is a
                    complete month as of this cut.
     27,457,010.09  Aug 18 2026 export, section-stack parser, + carried-forward
                    St. Louis. Every earlier figure on this line was produced by
                    the parser that misread accounts as companies and dropped
                    whole facilities, so none of them are kept as history. */
ok(GRAND.toFixed(2) === "29826050.36", "source ties to the known grand total", "$" + GRAND.toFixed(2));

const PAIRS: [Dim, Dim][] = [
  ["facility", "month"],
  ["month", "kpi_group"],
  ["facility", "kpi_group"],
];

for (const [rowDim, colDim] of PAIRS) {
  const p = pivot(rows, rowDim, colDim, {});
  const label = `${rowDim} x ${colDim}`;

  ok(
    r2(p.grand.amount).toFixed(2) === GRAND.toFixed(2),
    `${label}: grand total preserved`,
    "$" + r2(p.grand.amount).toFixed(2),
  );
  ok(p.grand.n === GRAND_N, `${label}: grand count preserved`, `${p.grand.n}`);

  const rowSum = r2([...p.rowTotals.values()].reduce((s, c) => s + c.amount, 0));
  const colSum = r2([...p.colTotals.values()].reduce((s, c) => s + c.amount, 0));
  ok(rowSum.toFixed(2) === GRAND.toFixed(2), `${label}: row totals sum to grand`, "$" + rowSum.toFixed(2));
  ok(colSum.toFixed(2) === GRAND.toFixed(2), `${label}: col totals sum to grand`, "$" + colSum.toFixed(2));

  // Every cell must equal a direct sum of the rows it covers.
  let cellMismatch = 0;
  for (const rk of p.rowKeys) {
    for (const ck of p.colKeys) {
      const got = p.cells.get(cellKey(rk, ck));
      const want = rows.filter((r) => dimValue(r, rowDim) === rk && dimValue(r, colDim) === ck);
      const wantAmt = r2(want.reduce((s, r) => s + r.amount, 0));
      const gotAmt = r2(got?.amount ?? 0);
      if (gotAmt.toFixed(2) !== wantAmt.toFixed(2)) cellMismatch++;
    }
  }
  ok(cellMismatch === 0, `${label}: every cell equals a direct sum`, `${cellMismatch} mismatched`);
}

// Filtering the third dimension must equal summing that slice directly.
{
  const p = pivot(rows, "facility", "month", { kpi_group: "Payroll Expenses" });
  const want = r2(rows.filter((r) => r.kpi_group === "Payroll Expenses").reduce((s, r) => s + r.amount, 0));
  ok(
    r2(p.grand.amount).toFixed(2) === want.toFixed(2),
    "filtered pivot equals a direct slice sum",
    "$" + want.toFixed(2),
  );
}

// Same dimension on both axes is a caller error, not a silent wrong answer.
{
  let threw = false;
  try {
    pivot(rows, "month", "month", {});
  } catch {
    threw = true;
  }
  ok(threw, "pivot refuses the same dimension on both axes");
}

// avgPerFullMonth() — REGRESSION. Written inline in the dashboard, the divisor
// counted every full month in the warehouse while the numerator honoured the
// month picker, so a single month divided by four and August printed "$0".
{
  /* Derived from the LIVE data, not a pinned list. The previous version hardcoded
     its own five months, which is why it kept passing while the app's pinned
     PARTIAL_MONTH was drifting toward being wrong — the test and the code shared
     the same stale assumption instead of checking each other.

     The CLOCK is pinned, though — partialMonth() now consults the calendar (the
     newest month stops being partial once its last day arrives), so an unpinned
     clock would make these assertions change meaning on the first of a month.
     MID_MONTH sits inside the newest data month, so under it that month is
     partial — the regime the regression lived in. */
  const months = [...new Set(rows.map((r) => r.posted_period))].sort();
  const NEWEST = months[months.length - 1];
  const MID_MONTH = `${NEWEST}-15`;
  const PARTIAL = partialMonth(months, MID_MONTH);
  ok(PARTIAL === NEWEST, "mid-month, the partial month is the newest month in the data", PARTIAL);
  const full = rows.filter((r) => r.posted_period !== PARTIAL);
  const fullSum = full.reduce((s, r) => s + r.amount, 0);

  const fullCount = months.length - 1;
  const all = avgPerFullMonth(rows, months, "All", MID_MONTH);
  ok(all !== null && Math.abs(all - fullSum / fullCount) < 0.005,
     `unfiltered average divides full-month spend by ${fullCount}`, "$" + (all ?? 0).toFixed(2));

  const july = rows.filter((r) => r.posted_period === "2026-07");
  const julySum = july.reduce((s, r) => s + r.amount, 0);
  const gotJuly = avgPerFullMonth(july, months, "2026-07", MID_MONTH);
  ok(gotJuly !== null && Math.abs(gotJuly - julySum) < 0.005, "one month selected averages to that month itself, not a quarter of it", "$" + (gotJuly ?? 0).toFixed(2));
  // The bug divided the selected month by the count of ALL full months. Assert
  // the figure is not that value. (Comparing against `all` would not work: July
  // happens to sit near the four-month average, so the two are close by
  // coincidence and a "much larger than average" test would fail on good code.)
  ok(gotJuly !== null && Math.abs(gotJuly - julySum / fullCount) > 0.005, "the one-month figure is not the whole-range division the bug produced", `$${(julySum / fullCount).toFixed(2)} would be the bug`);

  const aug = rows.filter((r) => r.posted_period === PARTIAL);
  ok(avgPerFullMonth(aug, months, PARTIAL as string, MID_MONTH) === null, "the partial month reports null, never a confident $0");
  /* Two months, so one of them is complete. With a SINGLE month the newest — and
     therefore only — month is the partial one, and "average per full month" has
     no answer: null is the honest result and 0 would be a confident lie. The old
     fixture passed a one-month list and got 0 only because the partial month was
     pinned to a literal that did not appear in it. */
  ok(avgPerFullMonth([], ["2026-04", "2026-05"], "All", "2026-05-15") === 0, "an empty but valid scope is a real zero, not null");
  ok(avgPerFullMonth([{ posted_period: "2026-04", amount: 100 }], ["2026-04"], "All", "2026-04-15") === null,
     "a single month is the partial one, so there is no full-month average to give");

  // The calendar rule itself: partial only while the month is still running.
  ok(partialMonth(["2026-04", "2026-08"], "2026-08-18") === "2026-08",
     "mid-month, the newest month is partial");
  ok(partialMonth(["2026-04", "2026-08"], "2026-08-31") === null,
     "on the month's last day the newest month is complete");
  ok(partialMonth(["2026-04", "2026-08"], "2026-09-05") === null,
     "after month end the newest month is complete");
  ok(partialMonth(["2026-01", "2026-02"], "2026-02-28") === null,
     "non-leap February closes on the 28th");
  ok(partialMonth(["2028-02"], "2028-02-28") === "2028-02",
     "leap February is still partial on the 28th");
  ok(avgPerFullMonth([{ posted_period: "2026-08", amount: 100 }], ["2026-08"], "All", "2026-08-31") === 100,
     "a closed newest month counts as a full month in the average");
}

// delta()
ok(delta({ amount: 110, n: 1 }, { amount: 100, n: 1 }) === 10, "delta is percent change", "+10%");
ok(delta({ amount: 90, n: 1 }, { amount: 100, n: 1 }) === -10, "delta handles a decrease", "-10%");
ok(delta({ amount: 50, n: 1 }, { amount: 0, n: 0 }) === null, "delta is null on a zero baseline (never Infinity)");
ok(delta({ amount: 50, n: 1 }, undefined) === null, "delta is null on a missing baseline");
ok(delta(undefined, { amount: 50, n: 1 }) === null, "delta is null on a missing current value");
// A negative baseline (a credit) would make percent change read backwards.
ok(delta({ amount: -50, n: 1 }, { amount: -100, n: 1 }) === null, "delta is null when the baseline is negative");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
