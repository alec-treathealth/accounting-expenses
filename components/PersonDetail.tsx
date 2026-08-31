"use client";

import { useMemo } from "react";
import { usd, usdShort, GROUP_COLOR, MONTH_LABEL, monthName } from "@/lib/format";
import { partialMonth } from "@/lib/pivot";
import {
  byGroup,
  byMonth,
  filterRamp,
  share,
  topVendorsFor,
  total,
  VENDOR_TOP_N,
  type RampPersonRow,
  type RampVendorRow,
} from "@/lib/ramp";
import { useWarehouse } from "@/components/WarehouseProvider";

const gcolor = (g: string) => `var(${GROUP_COLOR[g] ?? "--chart-8"})`;

/* One cardholder: what they spent, on which KPI groups, month by month, and at
 * which merchants — plus a way into the transactions behind every figure.
 */
export default function PersonDetail({
  person,
  rows,
  vendors,
  rampTotal,
}: {
  person: string;
  /** Already scoped to the current facility/month filters. */
  rows: RampPersonRow[];
  vendors: RampVendorRow[];
  /** Ramp spend for everyone in this scope, for the share figure. */
  rampTotal: number;
}) {
  const { data, facility, month, months, openDrill } = useWarehouse();

  const mine = useMemo(() => filterRamp(rows, { person }), [rows, person]);
  const t = useMemo(() => total(mine), [mine]);
  const groups = useMemo(() => byGroup(mine), [mine]);
  const trend = useMemo(() => byMonth(mine, months), [mine, months]);

  /* data.ramp, NOT the month-scoped `rows`. agg_ramp_vendor has no month
     dimension, so the merchant figures always span every month; dividing them
     by a month-scoped total printed "$41,203 of $9,120 (452%)". topVendorsFor
     derives its own denominator from these rows so numerator and denominator
     cannot disagree. The header total above stays month-scoped — that one is
     what the user actually asked to see. */
  const vs = useMemo(
    () => topVendorsFor(vendors, data.ramp, person, facility),
    [vendors, data.ramp, person, facility],
  );

  const pctOfRamp = share(t.amount, rampTotal);
  const gmax = Math.max(...groups.map((g) => Math.abs(g.amount)), 1);
  const tmax = Math.max(...trend.map((m) => Math.abs(m.amount)), 1);
  const vmax = Math.max(...vs.rows.map((v) => Math.abs(v.amount)), 1);

  const drillFilters = {
    person,
    ...(facility === "All" ? {} : { facility }),
    ...(month === "All" ? {} : { month }),
  };

  /**
   * Open the drawer on this cardholder, optionally narrowed further.
   *
   * `expected` MUST describe the population the drill actually returns. Passing
   * the whole-person total for a single-group drill would show the drawer a
   * figure it can never match — and, because that forced `compare: false`, it
   * also fired the drawer's "this came from the top-150 vendor extract" note,
   * which is untrue of agg_ramp_person: it ties to the Ramp slice exactly
   * (GUARD 4, migration 0008) using the SAME ramp_person() definition as the
   * drill, so every one of these figures is comparable.
   */
  const openPerson = (
    extra: Record<string, string> = {},
    title = person,
    expected: { amount: number; n: number } = t,
    source = "Cardholder total",
  ) =>
    openDrill({
      title,
      filters: { ...drillFilters, ...extra },
      expected: { amount: expected.amount, n: expected.n, source, compare: true },
    });

  return (
    <div className="person-detail">
      <div className="person-head">
        <div>
          <h2 className="person-name">{person}</h2>
          <p className="person-meta">
            {usd(t.amount)} on {t.n.toLocaleString()} Ramp charge{t.n === 1 ? "" : "s"}
            {pctOfRamp !== null && <> · {pctOfRamp}% of Ramp spend in this view</>}
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => openPerson()}>
          View transactions
        </button>
      </div>

      <section className="person-block">
        <h3>Spending mix</h3>
        {groups.map((g) => (
          <button
            type="button"
            key={g.kpi_group}
            className="bar-row dd-trigger"
            aria-label={`${g.kpi_group}, ${usd(g.amount)}. View transactions`}
            onClick={() =>
              openPerson({ kpi_group: g.kpi_group }, `${person} · ${g.kpi_group}`, g, "Cardholder × group total")
            }
          >
            <div className="bar-lab"><span className="sw" style={{ background: gcolor(g.kpi_group) }} />{g.kpi_group}</div>
            <div className="track">
              <div className="fill" style={{ width: (Math.abs(g.amount) / gmax) * 100 + "%", background: gcolor(g.kpi_group) }} />
            </div>
            <div className="bar-val">
              {usd(g.amount)} <span className="bar-sub">{g.n.toLocaleString()}</span>
            </div>
          </button>
        ))}
        {!groups.length && <p className="empty-note">No Ramp spend in this view.</p>}
      </section>

      {month === "All" && (
        <section className="person-block">
          <h3>Month by month</h3>
          <div className="spark">
            {trend.map((m) => (
              <div className="spark-col" key={m.month}>
                <div className="spark-val">{m.amount ? usdShort(m.amount) : "—"}</div>
                <div className="spark-track" aria-hidden="true">
                  <div className="spark-fill" style={{ height: `${(Math.abs(m.amount) / tmax) * 100}%` }} />
                </div>
                <div className="spark-lab">
                  {MONTH_LABEL[m.month] ?? monthName(m.month)}
                  {m.month === partialMonth(months) ? "*" : ""}
                </div>
              </div>
            ))}
          </div>
          {partialMonth(months) && (
            <p className="fine">
              * {monthName(partialMonth(months) as string)} is partial, so it is not comparable with a full
              month.
            </p>
          )}
        </section>
      )}

      <section className="person-block">
        <h3>Where the money went</h3>
        {vs.rows.map((v) => (
          <div className="bar-row" key={v.vendor}>
            <div className="bar-lab">{v.vendor}</div>
            <div className="track">
              <div className="fill" style={{ width: (Math.abs(v.amount) / vmax) * 100 + "%", background: "var(--seq)" }} />
            </div>
            <div className="bar-val">
              {usd(v.amount)} <span className="bar-sub">{v.n.toLocaleString()}</span>
            </div>
          </div>
        ))}
        {!vs.rows.length && <p className="empty-note">No merchant detail for this cardholder.</p>}
        {/* The warehouse keeps only the top 12 merchants per facility and person,
            so this list is DELIBERATELY incomplete. Saying so — with the covered
            share — is what stops a reader subtotalling it and finding it short. */}
        {vs.rows.length > 0 && (
          <p className="fine">
            {month !== "All" && "Merchant detail is not held by month, so these figures cover every month, not just the one selected. "}
            Top {VENDOR_TOP_N} merchants per facility
            {vs.coverage !== null && <> — {usd(vs.shown.amount)} of {usd(vs.covered.amount)} ({vs.coverage}%)</>}.
            The remainder is spread across smaller merchants.
          </p>
        )}
      </section>
    </div>
  );
}
