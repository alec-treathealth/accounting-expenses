"use client";

import { useMemo, useState } from "react";
import { usd, usdShort, GROUP_COLOR } from "@/lib/format";
import { byGroup, filterRamp, share, total, type RampPersonRow } from "@/lib/ramp";
import { useWarehouse } from "@/components/WarehouseProvider";

const gcolor = (g: string) => `var(${GROUP_COLOR[g] ?? "--chart-8"})`;

/* Cardholders side by side, KPI group by KPI group.
 *
 * People are COLUMNS and groups are ROWS, not the other way round: the question
 * this table answers is "does this person's mix look like that person's", which
 * means reading ACROSS a group. Two to four columns — beyond four the numbers
 * stop being comparable at a glance and the table needs horizontal scrolling to
 * hold a single comparison.
 *
 * The "% of person" mode exists because dollar columns cannot answer the mix
 * question when one cardholder spends forty times another: every one of their
 * cells is larger, which tells you nothing about where their money goes.
 */
export default function PersonCompare({
  people,
  rows,
}: {
  people: string[];
  /** Already scoped to the current facility/month filters. */
  rows: RampPersonRow[];
}) {
  const { facility, month, openDrill } = useWarehouse();
  const [asShare, setAsShare] = useState(false);

  const cols = useMemo(
    () =>
      people.map((person) => {
        const mine = filterRamp(rows, { person });
        const t = total(mine);
        const groups = new Map(byGroup(mine).map((g) => [g.kpi_group, g]));
        return { person, total: t, groups };
      }),
    [people, rows],
  );

  /* Union of the groups any selected person used, in house order. Intersecting
     instead would hide the most interesting fact a comparison can surface: a
     category one person spends in and another does not touch at all. */
  const groupRows = useMemo(() => {
    const seen = new Set<string>();
    for (const c of cols) for (const g of c.groups.keys()) seen.add(g);
    return byGroup(rows.filter((r) => seen.has(r.kpi_group))).map((g) => g.kpi_group);
  }, [cols, rows]);

  const cell = (colIdx: number, group: string) => {
    const c = cols[colIdx];
    const g = c.groups.get(group);
    if (!g) return null;
    if (!asShare) return usdShort(g.amount);
    const s = share(g.amount, c.total.amount);
    return s === null ? "—" : `${s}%`;
  };

  const openCell = (person: string, kpi_group: string, amount: number, n: number) =>
    openDrill({
      title: `${person} · ${kpi_group}`,
      filters: {
        person,
        kpi_group,
        ...(facility === "All" ? {} : { facility }),
        ...(month === "All" ? {} : { month }),
      },
      expected: { amount, n, source: "Cardholder × group total", compare: true },
    });

  return (
    <div className="person-detail">
      <div className="person-head">
        <div>
          <h2 className="person-name">Comparing {people.length} cardholders</h2>
          <p className="person-meta">Click any figure to see the transactions behind it.</p>
        </div>
        <div className="seg" role="radiogroup" aria-label="Value display">
          {([false, true] as const).map((s) => (
            <label key={String(s)} className="seg-opt">
              <input
                type="radio"
                name="ths-person-mode"
                checked={asShare === s}
                onChange={() => setAsShare(s)}
              />
              {s ? "% of person" : "$"}
            </label>
          ))}
        </div>
      </div>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">KPI group</th>
              {cols.map((c) => (
                <th key={c.person} scope="col" className="num">{c.person}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groupRows.map((group) => (
              <tr key={group}>
                <th scope="row">
                  <span className="sw" style={{ background: gcolor(group) }} /> {group}
                </th>
                {cols.map((c, i) => {
                  const g = c.groups.get(group);
                  return (
                    <td key={c.person} className="num">
                      {g ? (
                        <button
                          className="dd-link"
                          aria-label={`${c.person}, ${group}: ${usd(g.amount)}. View transactions`}
                          onClick={() => openCell(c.person, group, g.amount, g.n)}
                        >
                          {cell(i, group)}
                        </button>
                      ) : (
                        /* Absent, not zero. A person who never charged this
                           category has no row in the warehouse, and printing $0
                           would claim they spent nothing when the truth is that
                           they never used it. */
                        <span className="dd-dim">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {cols.map((c) => (
                <td key={c.person} className="num">{usdShort(c.total.amount)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Charges</th>
              {cols.map((c) => (
                <td key={c.person} className="num">{c.total.n.toLocaleString()}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
