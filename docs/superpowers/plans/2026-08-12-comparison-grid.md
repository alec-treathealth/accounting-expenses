# Comparison Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user compare facilities, months and KPI groups against one another via a pivot grid reachable from the top of the dashboard.

**Architecture:** Pure pivot arithmetic in `lib/pivot.ts` (no React, no I/O, independently verifiable); presentation in `components/CompareGrid.tsx`; `Dashboard.tsx` hosts an `Overview | Compare` toggle and passes down the `agg_group_month` rows it already loads. No backend work: every cell comes from the 472 rows already in memory, and cell clicks reuse the existing `TxnDrawer`.

**Tech Stack:** Next.js 14.2.35 App Router, React 18, TypeScript, existing Treat design system (`.seg`, `.card`, `.table`, `.btn`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-comparison-grid-design.md`
- **No test framework exists.** Tests are `.mts` scripts run by `tsx`, using `const ok = (cond, label, detail) => …` and ending `process.exit(failures === 0 ? 0 : 1)`. Copy the idiom from `verify/txn-drilldown.mts`. Do NOT add vitest/jest.
- Grand total across all data is **22851611.16** across **29864** rows. Pivoting must never change it.
- `gm` rows arrive with `posted_period` already sliced to `"YYYY-MM"` (see `Dashboard.tsx` where `setGm` maps `.slice(0, 7)`). Month keys are therefore `"2026-04"` … `"2026-08"`, never `"2026-04-01"`.
- `"2026-08"` is a **partial** month (1–11 Aug). It must never appear in a delta calculation.
- Money is rounded as the rest of the app does: `Math.round(x * 100) / 100`. Never `toFixed` for arithmetic.
- Colours come from existing tokens via `gcolor()` / CSS custom properties. Do NOT introduce hex values.
- Branch: `feat/treat-design-system`. Commit after each task.

## File Structure

| File | Responsibility |
|---|---|
| `lib/pivot.ts` (new) | Pure pivot maths: group rows into a matrix, totals, deltas. No React. |
| `verify/pivot.mts` (new) | Asserts pivot output against live `agg_group_month`. |
| `components/CompareGrid.tsx` (new) | Dimension pickers, filter, `$ / %` toggle, grid, cell clicks. |
| `components/Dashboard.tsx` (modify) | `Overview \| Compare` toggle in the header `.controls`; renders one or the other. |
| `package.json` (modify) | Adds `verify:pivot`. |

---

### Task 1: Pivot arithmetic

**Files:**
- Create: `lib/pivot.ts`
- Create: `verify/pivot.mts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Dim = "facility" | "month" | "kpi_group"`
  - `type AggRow = { facility: string; posted_period: string; kpi_group: string; amount: number; n: number }`
  - `type PivotCell = { amount: number; n: number }`
  - `type PivotResult = { rowKeys, colKeys, cells, rowTotals, colTotals, grand }`
  - `cellKey(row: string, col: string): string`
  - `pivot(rows: AggRow[], rowDim: Dim, colDim: Dim, filter: Partial<Record<Dim, string>>): PivotResult`
  - `delta(cur: PivotCell | undefined, base: PivotCell | undefined): number | null`
  - `DIM_LABEL: Record<Dim, string>`
  - `PARTIAL_MONTH = "2026-08"`

- [ ] **Step 1: Write the failing test**

Create `verify/pivot.mts`:

```ts
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

console.log(`source rows: ${rows.length}, grand $${GRAND.toFixed(2)}, n=${GRAND_N}`);
ok(GRAND.toFixed(2) === "22851611.16", "source ties to the known grand total", "$" + GRAND.toFixed(2));

const PAIRS: [Dim, Dim][] = [
  ["facility", "month"],
  ["month", "kpi_group"],
  ["facility", "kpi_group"],
];

for (const [rowDim, colDim] of PAIRS) {
  const p = pivot(rows, rowDim, colDim, {});
  const label = `${rowDim} x ${colDim}`;

  ok(r2(p.grand.amount).toFixed(2) === GRAND.toFixed(2), `${label}: grand total preserved`, "$" + r2(p.grand.amount).toFixed(2));
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
  ok(r2(p.grand.amount).toFixed(2) === want.toFixed(2), "filtered pivot equals a direct slice sum", "$" + want.toFixed(2));
}

// Same dimension on both axes is a caller error, not a silent wrong answer.
{
  let threw = false;
  try { pivot(rows, "month", "month", {}); } catch { threw = true; }
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
```

Add to `package.json` `scripts`, after `verify:lockout`:

```json
    "verify:pivot": "tsx verify/pivot.mts"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify:pivot`
Expected: FAIL — `lib/pivot.ts` does not exist, so the import throws.

- [ ] **Step 3: Implement `lib/pivot.ts`**

```ts
import { GROUP_ORDER } from "./format";

// Pure pivot arithmetic for the comparison grid. No React, no I/O, no fetching —
// which is what lets verify/pivot.mts assert it against the live warehouse
// without a browser or a test framework.

export type Dim = "facility" | "month" | "kpi_group";

export type AggRow = {
  facility: string;
  /** "YYYY-MM" — Dashboard.tsx slices this before it reaches us. */
  posted_period: string;
  kpi_group: string;
  amount: number;
  n: number;
};

export type PivotCell = { amount: number; n: number };

export type PivotResult = {
  rowKeys: string[];
  colKeys: string[];
  cells: Map<string, PivotCell>;
  rowTotals: Map<string, PivotCell>;
  colTotals: Map<string, PivotCell>;
  grand: PivotCell;
};

export const DIM_LABEL: Record<Dim, string> = {
  facility: "Facility",
  month: "Month",
  kpi_group: "KPI group",
};

/** August 2026 covers 1–11 only. Never let it into a delta. */
export const PARTIAL_MONTH = "2026-08";

/* A NUL separator cannot occur in a facility, month or account name, so the
   composite key is unambiguous. Joining on "-" would collide the moment a
   facility name contained one. */
export const cellKey = (row: string, col: string): string => `${row}\u0000${col}`;

const r2 = (x: number) => Math.round(x * 100) / 100;

export function dimValue(row: AggRow, d: Dim): string {
  return d === "month" ? row.posted_period : d === "facility" ? row.facility : row.kpi_group;
}

/* Ordering is per dimension because "sorted" means something different for each:
   months are chronological, KPI groups follow the house order used everywhere
   else in the app, and facilities are alphabetical because no other order is
   meaningful. */
function orderKeys(d: Dim, keys: Set<string>): string[] {
  const list = [...keys];
  if (d === "month") return list.sort();
  if (d === "kpi_group") {
    const rank = new Map(GROUP_ORDER.map((g, i) => [g, i]));
    return list.sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999) || a.localeCompare(b));
  }
  return list.sort((a, b) => a.localeCompare(b));
}

function add(map: Map<string, PivotCell>, key: string, amount: number, n: number): void {
  const cur = map.get(key);
  if (cur) {
    cur.amount += amount;
    cur.n += n;
  } else {
    map.set(key, { amount, n });
  }
}

/**
 * Group rows into a matrix. `filter` pins the dimensions not on an axis; an
 * absent or empty entry means "all".
 *
 * Throws when both axes are the same dimension: that would sum each row into a
 * single diagonal cell and silently report a wrong total.
 */
export function pivot(
  rows: AggRow[],
  rowDim: Dim,
  colDim: Dim,
  filter: Partial<Record<Dim, string>>,
): PivotResult {
  if (rowDim === colDim) throw new Error(`pivot: rowDim and colDim are both "${rowDim}"`);

  const cells = new Map<string, PivotCell>();
  const rowTotals = new Map<string, PivotCell>();
  const colTotals = new Map<string, PivotCell>();
  const rowSet = new Set<string>();
  const colSet = new Set<string>();
  const grand: PivotCell = { amount: 0, n: 0 };

  for (const row of rows) {
    let skip = false;
    for (const d of ["facility", "month", "kpi_group"] as Dim[]) {
      const want = filter[d];
      if (want && dimValue(row, d) !== want) { skip = true; break; }
    }
    if (skip) continue;

    const rk = dimValue(row, rowDim);
    const ck = dimValue(row, colDim);
    rowSet.add(rk);
    colSet.add(ck);
    add(cells, cellKey(rk, ck), row.amount, row.n);
    add(rowTotals, rk, row.amount, row.n);
    add(colTotals, ck, row.amount, row.n);
    grand.amount += row.amount;
    grand.n += row.n;
  }

  // Round once, at the end: rounding each addend would drift by cents.
  for (const m of [cells, rowTotals, colTotals]) {
    for (const [k, v] of m) m.set(k, { amount: r2(v.amount), n: v.n });
  }

  return {
    rowKeys: orderKeys(rowDim, rowSet),
    colKeys: orderKeys(colDim, colSet),
    cells,
    rowTotals,
    colTotals,
    grand: { amount: r2(grand.amount), n: grand.n },
  };
}

/**
 * Percent change from `base` to `cur`, or null when the comparison would be
 * meaningless. Null — not 0, not Infinity — because "no baseline" and "no
 * change" are different facts and the UI must be able to tell them apart.
 *
 * A negative baseline also returns null: a swing from -100 to -50 is an
 * improvement, but the arithmetic reports -50%, which reads as a fall.
 */
export function delta(cur: PivotCell | undefined, base: PivotCell | undefined): number | null {
  if (!cur || !base) return null;
  if (base.amount <= 0) return null;
  return Math.round(((cur.amount - base.amount) / base.amount) * 1000) / 10;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run verify:pivot`
Expected: `ALL CHECKS PASSED`, exit 0.

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/pivot.ts verify/pivot.mts package.json
git commit -m "Add pure pivot arithmetic for the comparison grid"
```

---

### Task 2: The grid component

**Files:**
- Create: `components/CompareGrid.tsx`

**Interfaces:**
- Consumes: `pivot`, `delta`, `cellKey`, `DIM_LABEL`, `PARTIAL_MONTH`, `type Dim`, `type AggRow`, `type PivotCell` from `@/lib/pivot`; `usd`, `usdShort`, `MONTH_LABEL`, `monthName` from `@/lib/format`; `type DrillFilters` from `@/components/TxnDrawer`
- Produces: `export default function CompareGrid(props: CompareGridProps)` where

```ts
export type CompareGridProps = {
  rows: AggRow[];
  /** Opens the existing transaction drawer for a cell. */
  onCell: (filters: DrillFilters, title: string) => void;
};
```

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useMemo, useState } from "react";
import {
  DIM_LABEL,
  PARTIAL_MONTH,
  cellKey,
  delta,
  pivot,
  type AggRow,
  type Dim,
  type PivotCell,
} from "@/lib/pivot";
import { MONTH_LABEL, monthName, usd, usdShort } from "@/lib/format";
import { type DrillFilters } from "@/components/TxnDrawer";

export type CompareGridProps = {
  rows: AggRow[];
  onCell: (filters: DrillFilters, title: string) => void;
};

const DIMS: Dim[] = ["facility", "month", "kpi_group"];

/* Months are shown by their short house label so the grid matches the chart
   axis; everything else shows its own name. */
const keyLabel = (d: Dim, k: string) => (d === "month" ? MONTH_LABEL[k] ?? k : k);

/** The dimension not on either axis becomes the filter. */
const thirdDim = (rowDim: Dim, colDim: Dim): Dim =>
  DIMS.find((d) => d !== rowDim && d !== colDim) as Dim;

/** Maps a cell back to the drill-down filters that produced it. */
function filtersFor(rowDim: Dim, rowKey: string, colDim: Dim, colKey: string, third: Dim, thirdVal: string): DrillFilters {
  const f: DrillFilters = {};
  const put = (d: Dim, v: string) => {
    if (!v) return;
    if (d === "facility") f.facility = v;
    else if (d === "month") f.month = v;
    else f.kpi_group = v;
  };
  put(rowDim, rowKey);
  put(colDim, colKey);
  put(third, thirdVal);
  return f;
}

export default function CompareGrid({ rows, onCell }: CompareGridProps) {
  const [rowDim, setRowDim] = useState<Dim>("facility");
  const [colDim, setColDim] = useState<Dim>("month");
  const [thirdVal, setThirdVal] = useState<string>("");
  const [asShare, setAsShare] = useState(false);

  const third = thirdDim(rowDim, colDim);

  /* Values available for the third dimension, drawn from the data rather than a
     constant so a new facility or group needs no code change. */
  const thirdOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(third === "month" ? r.posted_period : third === "facility" ? r.facility : r.kpi_group);
    return [...s].sort();
  }, [rows, third]);

  const p = useMemo(
    () => pivot(rows, rowDim, colDim, thirdVal ? { [third]: thirdVal } : {}),
    [rows, rowDim, colDim, third, thirdVal],
  );

  /* Delta only makes sense across time, and only between two FULL months —
     August covers 11 days, so including it would report a ~65% collapse that
     describes the calendar rather than the business. */
  const deltaCols = useMemo(() => {
    if (colDim !== "month") return null;
    const full = p.colKeys.filter((k) => k !== PARTIAL_MONTH);
    if (full.length < 2) return null;
    return { cur: full[full.length - 1], base: full[full.length - 2] };
  }, [colDim, p.colKeys]);

  /* Changing an axis to the dimension already on the other axis would be a
     degenerate pivot, so swap them instead of refusing. */
  const pickRow = (d: Dim) => {
    if (d === colDim) setColDim(rowDim);
    setRowDim(d);
    setThirdVal("");
  };
  const pickCol = (d: Dim) => {
    if (d === rowDim) setRowDim(colDim);
    setColDim(d);
    setThirdVal("");
  };

  const show = (c: PivotCell | undefined, rowKey: string) => {
    if (!c) return "—"; // no data is not zero, and the grid must not claim it is
    if (!asShare) return usdShort(c.amount);
    const rt = p.rowTotals.get(rowKey);
    if (!rt || rt.amount <= 0) return "—";
    return `${Math.round((c.amount / rt.amount) * 1000) / 10}%`;
  };

  if (!p.rowKeys.length) {
    return (
      <div className="card" style={{ padding: "var(--space-5)" }}>
        <p style={{ margin: 0, color: "var(--text-meta)" }}>
          No spend matches this selection.
        </p>
      </div>
    );
  }

  return (
    <section className="card" style={{ padding: "var(--space-5)" }}>
      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <label className="field" style={{ gap: 4 }}>
          <span>Rows</span>
          <select className="input" value={rowDim} onChange={(e) => pickRow(e.target.value as Dim)}>
            {DIMS.map((d) => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
          </select>
        </label>

        <label className="field" style={{ gap: 4 }}>
          <span>Columns</span>
          <select className="input" value={colDim} onChange={(e) => pickCol(e.target.value as Dim)}>
            {DIMS.map((d) => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
          </select>
        </label>

        <label className="field" style={{ gap: 4 }}>
          <span>{DIM_LABEL[third]}</span>
          <select className="input" value={thirdVal} onChange={(e) => setThirdVal(e.target.value)}>
            <option value="">All</option>
            {thirdOptions.map((v) => (
              <option key={v} value={v}>{third === "month" ? `${monthName(v)}${v === PARTIAL_MONTH ? " (partial)" : ""}` : v}</option>
            ))}
          </select>
        </label>

        <div className="seg" role="radiogroup" aria-label="Value display" style={{ marginLeft: "auto" }}>
          {([false, true] as const).map((s) => (
            <label key={String(s)} className="seg-opt">
              <input type="radio" name="ths-compare-mode" checked={asShare === s} onChange={() => setAsShare(s)} />
              {s ? "% of row" : "$"}
            </label>
          ))}
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{DIM_LABEL[rowDim]}</th>
              {p.colKeys.map((ck) => (
                <th key={ck} scope="col" className="num">
                  {keyLabel(colDim, ck)}
                </th>
              ))}
              <th scope="col" className="num">Total</th>
              {deltaCols && (
                <th scope="col" className="num">
                  {MONTH_LABEL[deltaCols.cur]} vs {MONTH_LABEL[deltaCols.base]}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {p.rowKeys.map((rk) => {
              const d = deltaCols
                ? delta(p.cells.get(cellKey(rk, deltaCols.cur)), p.cells.get(cellKey(rk, deltaCols.base)))
                : null;
              return (
                <tr key={rk}>
                  <th scope="row">{keyLabel(rowDim, rk)}</th>
                  {p.colKeys.map((ck) => {
                    const c = p.cells.get(cellKey(rk, ck));
                    return (
                      <td key={ck} className="num">
                        {c ? (
                          <button
                            className="dd-link"
                            aria-label={`${keyLabel(rowDim, rk)}, ${keyLabel(colDim, ck)}: ${usd(c.amount)}. View transactions`}
                            onClick={() =>
                              onCell(
                                filtersFor(rowDim, rk, colDim, ck, third, thirdVal),
                                `${keyLabel(rowDim, rk)} · ${keyLabel(colDim, ck)}`,
                              )
                            }
                          >
                            {show(c, rk)}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    );
                  })}
                  <td className="num">{usdShort(p.rowTotals.get(rk)?.amount ?? 0)}</td>
                  {deltaCols && (
                    <td className="num" style={{ color: d === null ? "var(--text-meta)" : undefined }}>
                      {d === null ? "—" : `${d > 0 ? "+" : ""}${d}%`}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {p.colKeys.map((ck) => (
                <td key={ck} className="num">{usdShort(p.colTotals.get(ck)?.amount ?? 0)}</td>
              ))}
              <td className="num">{usdShort(p.grand.amount)}</td>
              {deltaCols && <td className="num">—</td>}
            </tr>
          </tfoot>
        </table>
      </div>

      <p style={{ marginTop: "var(--space-3)", color: "var(--text-meta)", fontSize: "var(--size-ui-sm)" }}>
        {colDim === "month" || rowDim === "month" || third === "month"
          ? "August is partial (through Aug 11) and is excluded from change columns. "
          : ""}
        Click any figure to see the transactions behind it.
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add components/CompareGrid.tsx
git commit -m "Add the comparison grid component"
```

---

### Task 3: Host it on the dashboard

**Files:**
- Modify: `components/Dashboard.tsx`

**Interfaces:**
- Consumes: `CompareGrid` from Task 2; existing `gm` state, `openAgg()` and `MONTHS` in `Dashboard.tsx`
- Produces: nothing

- [ ] **Step 1: Import the component**

In `components/Dashboard.tsx`, add after the `TxnDrawer` import:

```tsx
import CompareGrid from "@/components/CompareGrid";
```

- [ ] **Step 2: Add the view state**

Immediately after the existing `const [drill, setDrill] = useState<DrillContext | null>(null);` line, add:

```tsx
  /* Overview or Compare. The toggle lives in the header controls so comparison
     is reachable from the top of the page rather than buried below the fold. */
  const [view, setView] = useState<"overview" | "compare">("overview");
```

- [ ] **Step 3: Add the toggle to the header controls**

In the `<div className="controls">` block, immediately BEFORE the existing
`<div className="seg" role="radiogroup" aria-label="Density">`, insert:

```tsx
          <div className="seg" role="radiogroup" aria-label="View">
            {(["overview", "compare"] as const).map((v) => (
              <label key={v} className="seg-opt">
                <input type="radio" name="ths-view" checked={view === v} onChange={() => setView(v)} />
                {v === "overview" ? "Overview" : "Compare"}
              </label>
            ))}
          </div>
```

- [ ] **Step 4: Render the grid**

Find the line that renders the drawer near the end of the component:

```tsx
      {drill && <TxnDrawer ctx={drill} onClose={() => setDrill(null)} />}
```

Immediately BEFORE the first `<section` that follows the KPI cards — i.e. wrap the
existing overview body — is more invasive than needed. Instead, render the grid
directly above the KPI card row and hide the rest when in compare mode.

Locate the opening of the KPI card row (the element containing the card with
`<div className="lab">Total spend</div>`). Wrap from that element through to the
element immediately before `{drill && <TxnDrawer …>}` in a fragment guarded by
the view, and add the grid:

```tsx
      {view === "compare" ? (
        <CompareGrid rows={gm} onCell={(filters, title) => openAgg(filters, title)} />
      ) : (
        <>
          {/* ...existing overview markup, unchanged... */}
        </>
      )}
```

Do not alter the markup inside the fragment; only indent it.

- [ ] **Step 5: Verify it compiles and builds**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx next build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 6: Verify behaviour in the browser**

Run: `npx next dev -p 3114`, sign in, then:

1. The header shows `Overview | Compare`. Expected: present, Overview selected.
2. Click Compare. Expected: grid renders with Facility down the side and Apr–Aug across the top; the Total row equals **$22,851,611.16**.
3. Set the KPI group filter to Payroll Expenses. Expected: grand total becomes **$8,720,621.70**.
4. Switch Columns to KPI group. Expected: the delta column disappears (it is month-only) and the grand total is unchanged.
5. Set Rows to Month while Columns is Month. Expected: the axes swap rather than erroring.
6. Click any cell. Expected: the transaction drawer opens and its total ties to the cell.
7. Toggle `% of row`. Expected: each row's cells sum to 100%.

- [ ] **Step 7: Commit**

```bash
git add components/Dashboard.tsx
git commit -m "Add Overview/Compare toggle and host the comparison grid"
```

---

## Self-Review

**Spec coverage.** Pivot grid with any two dimensions and the third filtered → Task 1 (`pivot`) and Task 2 (pickers). Placement in the header `.controls` → Task 3 Step 3. Partial August excluded from deltas → Task 1 (`PARTIAL_MONTH`), Task 2 (`deltaCols`). `$ / % of row` toggle → Task 2 (`asShare`). Cell drill-through via the existing drawer → Task 2 (`onCell`) and Task 3 Step 4. Data layer unchanged → no migration in any task. Error and empty states → Task 2 (empty-state card, `—` for absent cells, `—` for null delta). Testing → Task 1 (`verify/pivot.mts`).

**Deviations from the spec, deliberate:**
1. The spec sketch showed a `vs Jun` column generally; the plan restricts the delta column to when **Columns = Month**, because "change" across facilities or KPI groups has no ordering and would be meaningless.
2. `delta()` also returns null for a **negative baseline**. The spec did not mention it; a credit balance would otherwise report an improvement as a fall.
3. Choosing a dimension already on the other axis **swaps** the axes rather than being prevented, which is less surprising than a disabled option.

**Placeholders.** None. Task 3 Step 4 describes a wrap of existing markup rather than reproducing the whole file, and states explicitly that the inner markup is unchanged.

**Type consistency.** `AggRow` in Task 1 matches the shape of `GM` in `Dashboard.tsx` (`facility`, `posted_period`, `kpi_group`, `amount`, `n`), so `rows={gm}` type-checks. `cellKey(row, col)` is defined in Task 1 and used identically in Tasks 1 and 2. `DrillFilters` is imported from `TxnDrawer` in Task 2 and produced by `filtersFor`, matching `openAgg(filters, title)` in Task 3.

**Known risk.** Task 3 Step 4 is the only structural edit to a large existing file. If the wrap is misapplied the overview will render in both modes; Step 6 check 2 catches it.
