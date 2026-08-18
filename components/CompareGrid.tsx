"use client";

import { useMemo, useState } from "react";
import {
  DIM_LABEL,
  partialMonth,
  cellKey,
  delta,
  pivot,
  type AggRow,
  type Dim,
  type PivotCell,
} from "@/lib/pivot";
import { MONTH_LABEL, monthName, usd, usdShort } from "@/lib/format";
import { type DrillFilters } from "@/components/TxnDrawer";
import Select from "@/components/Select";

export type CompareGridProps = {
  rows: AggRow[];
  /** Opens the existing transaction drawer for a cell. */
  onCell: (filters: DrillFilters, title: string) => void;
};

const DIMS: Dim[] = ["facility", "month", "kpi_group"];

/* Months use the short house label so the grid reads the same as the chart
   axis; everything else shows its own name. */
const keyLabel = (d: Dim, k: string) => (d === "month" ? MONTH_LABEL[k] ?? k : k);

/** The dimension not on either axis becomes the filter. */
const thirdDim = (rowDim: Dim, colDim: Dim): Dim =>
  DIMS.find((d) => d !== rowDim && d !== colDim) as Dim;

/** Maps a cell back to the drill-down filters that produced it. */
function filtersFor(
  rowDim: Dim,
  rowKey: string,
  colDim: Dim,
  colKey: string,
  third: Dim,
  thirdVal: string,
): DrillFilters {
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

  /* Options come from the data rather than a constant, so a new facility or
     group needs no code change here. */
  const thirdOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      s.add(third === "month" ? r.posted_period : third === "facility" ? r.facility : r.kpi_group);
    }
    return [...s].sort();
  }, [rows, third]);

  const p = useMemo(
    () => pivot(rows, rowDim, colDim, thirdVal ? { [third]: thirdVal } : {}),
    [rows, rowDim, colDim, third, thirdVal],
  );

  /* Delta only means something across time, and only between two FULL months.
     August covers 11 days, so including it would report a ~65% collapse that
     describes the calendar rather than the business. */
  /* Derived from EVERY month in the source rows, not from the visible columns:
     under a filter the newest visible column may be a complete month, and
     calling that one partial would drop a real month out of the delta. */
  const partial = useMemo(() => partialMonth(rows.map((r) => r.posted_period)), [rows]);
  const deltaCols = useMemo(() => {
    if (colDim !== "month") return null;
    const full = p.colKeys.filter((k) => k !== partial);
    if (full.length < 2) return null;
    return { cur: full[full.length - 1], base: full[full.length - 2] };
  }, [colDim, p.colKeys, partial]);

  /* Picking the dimension already on the other axis would be a degenerate
     pivot, so swap the two rather than refusing the choice. */
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

  const monthInvolved = rowDim === "month" || colDim === "month" || third === "month";

  return (
    <section className="card" style={{ padding: "var(--space-5)" }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-3)",
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: "var(--space-4)",
        }}
      >
        <div className="field" style={{ gap: 4 }}>
          <span>Rows</span>
          <Select
            label="Rows"
            value={rowDim}
            onChange={(v) => pickRow(v as Dim)}
            options={DIMS.map((d) => ({ value: d, label: DIM_LABEL[d] }))}
          />
        </div>

        <div className="field" style={{ gap: 4 }}>
          <span>Columns</span>
          <Select
            label="Columns"
            value={colDim}
            onChange={(v) => pickCol(v as Dim)}
            options={DIMS.map((d) => ({ value: d, label: DIM_LABEL[d] }))}
          />
        </div>

        <div className="field" style={{ gap: 4 }}>
          <span>{DIM_LABEL[third]}</span>
          <Select
            label={DIM_LABEL[third]}
            value={thirdVal}
            onChange={setThirdVal}
            options={[
              { value: "", label: "All" },
              ...thirdOptions.map((v) => ({
                value: v,
                label: third === "month" ? `${monthName(v)}${v === partial ? " (partial)" : ""}` : v,
              })),
            ]}
          />
        </div>

        <div className="seg" role="radiogroup" aria-label="Value display" style={{ marginLeft: "auto" }}>
          {([false, true] as const).map((s) => (
            <label key={String(s)} className="seg-opt">
              <input
                type="radio"
                name="ths-compare-mode"
                checked={asShare === s}
                onChange={() => setAsShare(s)}
              />
              {s ? "% of row" : "$"}
            </label>
          ))}
        </div>
      </div>

      {!p.rowKeys.length ? (
        <p style={{ margin: 0, color: "var(--text-meta)" }}>No spend matches this selection.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{DIM_LABEL[rowDim]}</th>
                {p.colKeys.map((ck) => (
                  <th key={ck} scope="col" className="num">{keyLabel(colDim, ck)}</th>
                ))}
                <th scope="col" className="num">Total</th>
                {deltaCols && (
                  <th scope="col" className="num">
                    {MONTH_LABEL[deltaCols.cur] ?? monthName(deltaCols.cur)} vs{" "}
                    {MONTH_LABEL[deltaCols.base] ?? monthName(deltaCols.base)}
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
      )}

      <p style={{ marginTop: "var(--space-3)", color: "var(--text-meta)", fontSize: "var(--size-ui-sm)" }}>
        {monthInvolved ? "August is partial (through Aug 18) and is excluded from change columns. " : ""}
        Click any figure to see the transactions behind it.
      </p>
    </section>
  );
}
