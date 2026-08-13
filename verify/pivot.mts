// Asserts the pivot maths against the live agg_group_month. Pivoting must not
// create or lose money: every pairing of dimensions has to reproduce the same
// grand total, and every cell has to equal a direct sum of the rows it covers.
//
//   npm run verify:pivot

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { cellKey, delta, dimValue, pivot, type AggRow, type Dim } from "../lib/pivot.ts";

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
ok(GRAND.toFixed(2) === "22851611.16", "source ties to the known grand total", "$" + GRAND.toFixed(2));

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
