"use client";

import { useMemo } from "react";
import { usd, usdShort, pct, GROUP_COLOR, GROUP_ORDER, MONTH_LABEL, monthName, monthRangeLabel } from "@/lib/format";
import { avgPerFullMonth, partialMonth } from "@/lib/pivot";
import { costPerBed, splitSpend } from "@/lib/spend";
import { useDatasets, useWarehouse } from "@/components/WarehouseProvider";
import { Sk, SkRows, rise } from "@/components/Skeleton";

/* The overview: how much was spent, on what, and where.
 *
 * Data, filters and the drill-down all come from the warehouse context now, so
 * this file is a rendering concern only — no fetching, no auth, no filter state.
 * The header and the facility/month pickers moved to the shell's top bar, where
 * every route shares them.
 */

/* A KPI group's colour is the design-system chart-series custom property used as
   a CSS value, not a resolved hex: var() follows [data-ground] for free, in CSS,
   with no React involvement. SVG `fill` accepts it exactly like `background`. */
const gcolor = (g: string) => `var(${GROUP_COLOR[g] ?? "--chart-8"})`;

export default function Dashboard() {
  useDatasets(["aa", "av"]);
  const { data, got, facility, month, months, rosterCount, openDrill, scope, aggFor, today } = useWarehouse();
  const { gm, aa, av } = data;

  const fac = facility;
  const mon = month;

  // agg_group_month covers the full population, so its figure is comparable and
  // the drawer can assert the detail sums to it.
  const openAgg = (filters: Parameters<typeof aggFor>[0], title: string) => {
    const a = aggFor(filters);
    openDrill({ title, filters, expected: { amount: a.amount, n: a.n, source: "Dashboard figure", compare: true } });
  };

  const rows = useMemo(
    () => gm.filter((r) => (fac === "All" || r.facility === fac) && (mon === "All" || r.posted_period === mon)),
    [gm, fac, mon],
  );

  /* ONE helper behind both spend cards and the Cost per Bed numerator, so the
     three cannot disagree. `split.all` is the figure this dashboard has always
     reported; `split.operating` is that figure with Cost of Goods Sold taken
     out. Shares elsewhere on the page still divide by `split.all` — dividing a
     group by the operating figure would put COGS above 100%. */
  const split = useMemo(() => splitSpend(rows), [rows]);
  const total = split.all;

  /* Cost per LICENSED BED. Scoped by the same `rows` as everything else, so it
     honours the facility and month pickers for free. dim_facility carries the
     capacity; facilities with no bed count on file are named on the card rather
     than being folded in as a zero. */
  const perBed = useMemo(
    () => costPerBed(rows, data.dim, (f) => fac === "All" || f === fac),
    [rows, data.dim, fac],
  );

  const byGroup = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { m[r.kpi_group] = (m[r.kpi_group] || 0) + r.amount; });
    return Object.entries(m).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const byFac = useMemo(() => {
    const m: Record<string, number> = {};
    gm.filter((r) => mon === "All" || r.posted_period === mon).forEach((r) => {
      m[r.facility] = (m[r.facility] || 0) + r.amount;
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [gm, mon]);

  const big = byGroup[0] || ["—", 0];

  /* Average over FULL months only — August covers 11 days. The numerator and
     denominator have to be scoped identically, which is fiddly enough that it
     lives in lib/pivot.ts where verify/pivot.mts can assert it. */
  const avgFull = useMemo(() => avgPerFullMonth(rows, months, mon, today), [rows, months, mon, today]);

  /* Range captions, derived. Hardcoded, these read "(Aug partial)" long after
     August had closed — partialMonth() is null once the newest month's calendar
     is over, and every caption below must follow it the same way the averages
     already do. `today` comes from the provider so midnight moves them all. */
  const partial = partialMonth(months, today);
  const short = (m: string) => MONTH_LABEL[m] ?? monthName(m);
  const rangeLabel = monthRangeLabel(months)
    ? `${monthRangeLabel(months)}${partial ? ` (${short(partial)} partial)` : ""}`
    : " ";
  /* The average covers the FULL months only, so its caption names those and
     not `rangeLabel` — which spans the partial month this figure excludes. */
  const fullRangeLabel = monthRangeLabel(months.filter((m) => m !== partial));

  const vendors = useMemo(() => {
    const rs = av.filter((v) => fac === "All" || v.facility === fac);
    const agg: Record<string, { vendor: string; group: string; amount: number; n: number }> = {};
    rs.forEach((v) => {
      const k = v.vendor + "||" + v.kpi_group;
      agg[k] = agg[k] || { vendor: v.vendor, group: v.kpi_group, amount: 0, n: 0 };
      agg[k].amount += v.amount;
      agg[k].n += v.n;
    });
    return Object.values(agg).sort((a, b) => b.amount - a.amount).slice(0, 15);
  }, [av, fac]);

  const exceptions = useMemo(
    () =>
      aa
        .filter((a) => a.kpi_group === "Unclassified expense" || a.kpi_group === "Unmapped")
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    [aa],
  );
  const unclTot = exceptions.reduce((s, r) => s + r.amount, 0);

  const stack = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    months.forEach((mo) => (m[mo] = {}));
    gm.filter((r) => fac === "All" || r.facility === fac).forEach((r) => {
      if (!m[r.posted_period]) return;
      m[r.posted_period][r.kpi_group] = (m[r.posted_period][r.kpi_group] || 0) + r.amount;
    });
    const totals = months.map((mo) => GROUP_ORDER.reduce((a, g) => a + (m[mo][g] || 0), 0));
    return { m, totals, max: Math.max(...totals, 1) };
  }, [gm, fac, months]);

  const gmax = Math.max(...byGroup.map((g) => Math.abs(g[1])), 1);
  const fmax = Math.max(...byFac.map((f) => Math.abs(f[1])), 1);

  const W = 680, H = 210, padB = 26, padT = 8;
  const gap = (W - 8) / Math.max(months.length, 1);
  const bw = Math.min(66, gap - 14);

  return (
    <>
      <p className="page-note">
        {rosterCount} residential facilities · every figure below reconciles to the QuickBooks export to
        the penny.
      </p>

      <div className="grid kpis">
        {/* The full figure keeps the drill-down, because it is the one that ties
            to aggFor() exactly. Operating Expenses is a subset of it and the
            drawer can only filter ONE kpi_group, so offering it a "view
            transactions" link would open a set that does not sum to the number
            printed above it. */}
        <div className="card kpi ths-rise" style={rise(0)}>
          <div className="lab">COGS + Expenses</div>
          <div className="val">{got.gm ? usd(split.all) : <Sk className="sk-kpi" />}</div>
          <div className="foot">
            {mon === "All" ? rangeLabel : `${short(mon)} 2026`}
          </div>
          <div className="dd-hint">
            {fac === "All" && mon === "All" ? (
              "Filter by facility or month to drill down"
            ) : (
              <button className="dd-link" onClick={() => openAgg(scope(), "COGS + Expenses")}>
                View transactions
              </button>
            )}
          </div>
        </div>

        <div className="card kpi ths-rise" style={rise(1)}>
          <div className="lab">Operating Expenses</div>
          <div className="val">{got.gm ? usd(split.operating) : <Sk className="sk-kpi" />}</div>
          <div className="foot">
            {got.gm
              ? `Excludes ${usd(split.cogs)} cost of goods sold`
              : " "}
          </div>
          <div className="dd-hint">
            {got.gm ? `${pct((split.operating / (total || 1)))} of all spend in this view` : " "}
          </div>
        </div>

        <div className="card kpi ths-rise" style={rise(2)}>
          <div className="lab">Cost per bed</div>
          <div className="val">
            {!got.gm || !got.dim ? (
              <Sk className="sk-kpi" />
            ) : perBed.perBed === null ? (
              "No bed count on file"
            ) : (
              usd(perBed.perBed)
            )}
          </div>
          <div className="foot">
            {!got.gm || !got.dim
              ? " "
              : perBed.perBed === null
                ? "No facility in this view has a licensed capacity recorded"
                : `Cumulative over ${
                    mon === "All" ? rangeLabel : `${short(mon)} 2026`
                  } · ${perBed.beds} beds, ${perBed.counted.length} ${
                    perBed.counted.length === 1 ? "facility" : "facilities"
                  }`}
          </div>
          {/* TWO things a reader must know before trusting this number, and
              neither is inferable from the figure: it divides by licensed
              capacity, not occupancy (there is no census in this database, so
              it is not cost per client); and its numerator is operating
              expense less marketing, so it deliberately does NOT reconcile to
              the COGS + Expenses card beside it. */}
          <div className="dd-hint">
            Operating expenses excl. marketing · per licensed bed, not per client
          </div>
        </div>

        <div className="card kpi ths-rise" style={rise(3)}>
          <div className="lab">Largest group</div>
          <div className="val">{got.gm ? usd(big[1] as number) : <Sk className="sk-kpi" />}</div>
          <div className="foot">{got.gm ? `${big[0]} · ${pct((big[1] as number) / (total || 1))}` : " "}</div>
          <div className="dd-hint">
            {big[1] ? (
              <button
                className="dd-link"
                onClick={() => openAgg({ ...scope(), kpi_group: String(big[0]) }, String(big[0]))}
              >
                View transactions
              </button>
            ) : (
              "—"
            )}
          </div>
        </div>

        <div className="card kpi ths-rise" style={rise(4)}>
          <div className="lab">Avg / full month</div>
          <div className="val">
            {!got.gm ? <Sk className="sk-kpi" /> : avgFull === null ? "—" : usd(avgFull)}
          </div>
          <div className="foot">
            {mon === "All"
              ? partial
                ? fullRangeLabel
                  ? `${fullRangeLabel}, excludes partial ${short(partial)}`
                  : `${monthName(partial)} is partial — no full month in view`
                : rangeLabel
              : mon === partial
                ? `${monthName(mon)} is partial — no full month in view`
                : `${short(mon)} only`}
          </div>
        </div>
      </div>

      {/* Cost per bed's two disclosure states. A facility on either list is
          absent from the ratio ON PURPOSE, and naming it is the difference
          between a caveat and a silently wrong denominator. */}
      {got.gm && got.dim &&
        (perBed.excluded !== 0 || perBed.spendWithoutBeds.length > 0 || perBed.bedsWithoutSpend.length > 0) && (
        <p className="fine">
          {/* The gap between this ratio and the total-spend cards, in dollars.
              Without it a reader can only discover the difference by failing to
              reconcile two numbers that were never the same measure. */}
          {perBed.excluded !== 0 && perBed.perBed !== null && (
            <>
              <b>Cost per bed excludes {usd(perBed.excluded)}</b> of cost of goods sold and
              Advertising &amp; Marketing across the {perBed.counted.length} counted{" "}
              {perBed.counted.length === 1 ? "facility" : "facilities"} — it measures the operating
              cost of a licensed bed, so it does not reconcile to COGS + Expenses above.{" "}
            </>
          )}
          {perBed.spendWithoutBeds.length > 0 && (
            <>
              <b>No bed count on file:</b> {perBed.spendWithoutBeds.join(", ")} — their spend is in every
              figure above except Cost per bed, which cannot divide by a capacity it does not have.{" "}
            </>
          )}
          {perBed.bedsWithoutSpend.length > 0 && (
            <>
              <b>Beds but no spend in this view:</b> {perBed.bedsWithoutSpend.join(", ")} — counted as
              neither spend nor capacity, rather than as a facility that spent $0.
            </>
          )}
        </p>
      )}

      <section className="two">
        <div className="card">
          <h2>
            Spend by KPI group{" "}
            <span className="dd-dim" style={{ fontWeight: 400 }}>· click a bar for transactions</span>
          </h2>
          {!got.gm && <SkRows n={8} />}
          {byGroup.map(([g, v]) => (
            <button
              type="button"
              className="bar-row dd-trigger"
              key={g}
              title={`${g}: ${usd(v as number)} — view transactions`}
              aria-label={`${g}, ${usd(v as number)}. View transactions`}
              onClick={() => openAgg({ ...scope(), kpi_group: g }, g)}
            >
              <div className="bar-lab"><span className="sw" style={{ background: gcolor(g) }} />{g}</div>
              <div className="track">
                <div className="fill" style={{ width: (Math.abs(v as number) / gmax) * 100 + "%", background: gcolor(g) }} />
              </div>
              <div className="bar-val">
                {usd(v as number)} <span className="bar-sub">{pct((v as number) / (total || 1))}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="card">
          <h2>
            Spend by facility{" "}
            <span className="dd-dim" style={{ fontWeight: 400 }}>· click a bar for transactions</span>
          </h2>
          {!got.gm && <SkRows n={13} />}
          {byFac.map(([f, v]) => (
            <button
              type="button"
              className="bar-row dd-trigger"
              key={f}
              title={`${f}: ${usd(v as number)} — view transactions`}
              aria-label={`${f}, ${usd(v as number)}. View transactions`}
              onClick={() => openAgg({ facility: f, ...(mon === "All" ? {} : { month: mon }) }, f)}
            >
              <div className="bar-lab">{f}</div>
              <div className="track">
                <div
                  className="fill"
                  style={{ width: (Math.abs(v as number) / fmax) * 100 + "%", background: "var(--seq)", opacity: f === fac ? 1 : 0.85 }}
                />
              </div>
              <div className="bar-val">{usd(v as number)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Monthly spend by group{fac === "All" ? "" : " — " + fac}</h2>
        <div className="chart-scroll">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monthly spend by group">
            {[0, 1, 2, 3, 4].map((i) => {
              const y = padT + ((H - padT - padB) * i) / 4;
              return <line key={i} x1={8} x2={W} y1={y} y2={y} stroke="var(--chart-grid)" strokeWidth={1} />;
            })}
            {months.map((mo, i) => {
              const x = 8 + gap * i + (gap - bw) / 2;
              let yTop = H - padB;
              const rects = GROUP_ORDER.map((g) => {
                const val = stack.m[mo]?.[g] || 0;
                if (val <= 0) return null;
                const h = ((H - padT - padB) * val) / stack.max;
                yTop -= h;
                const open = () =>
                  openAgg(
                    { ...(fac === "All" ? {} : { facility: fac }), month: mo, kpi_group: g },
                    `${MONTH_LABEL[mo] ?? monthName(mo)} 2026 · ${g}`,
                  );
                return (
                  <rect
                    key={g}
                    x={x}
                    y={yTop}
                    width={bw}
                    height={Math.max(h - 2, 0)}
                    fill={gcolor(g)}
                    rx={1.5}
                    className="dd-seg"
                    role="button"
                    tabIndex={0}
                    aria-label={`${MONTH_LABEL[mo] ?? monthName(mo)} ${g}, ${usd(val)}. View transactions`}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open();
                      }
                    }}
                  >
                    <title>
                      {MONTH_LABEL[mo] ?? monthName(mo)} · {g}: {usd(val)} — click to view transactions
                    </title>
                  </rect>
                );
              });
              const tTop = H - padB - ((H - padT - padB) * stack.totals[i]) / stack.max - 5;
              return (
                <g key={mo}>
                  {rects}
                  <text x={x + bw / 2} y={H - 9} textAnchor="middle" fontSize={11} fill="var(--text-meta)">
                    {short(mo)}{mo === partial ? "*" : ""}
                  </text>
                  <text x={x + bw / 2} y={tTop} textAnchor="middle" fontSize={10.5} fill="var(--text-secondary)" className="mono">
                    {usdShort(stack.totals[i])}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="legend">
          {GROUP_ORDER.map((g) => (
            <span key={g}><span className="sw" style={{ background: gcolor(g) }} />{g}</span>
          ))}
          {partial && <span style={{ color: "var(--muted)" }}>* {monthName(partial)} is partial</span>}
        </div>
      </section>

      <section className="two">
        <div className="card">
          <h2>Top vendors{fac === "All" ? " (all facilities)" : " — " + fac}</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Vendor</th><th>Group</th><th className="num">Amount</th><th className="num">Txns</th></tr>
              </thead>
              <tbody>
                {!got.av && (
                  <tr><td colSpan={4} style={{ padding: 0 }}><SkRows n={6} /></td></tr>
                )}
                {vendors.map((v, i) => {
                  const ic = /\(IC\b|IC Vendor|IC Customer/i.test(v.vendor);
                  return (
                    <tr key={i}>
                      <td className="t">
                        <button
                          className="dd-link"
                          onClick={() =>
                            openDrill({
                              title: `${v.vendor} · ${v.group}`,
                              filters: { vendor: v.vendor, kpi_group: v.group, ...(fac === "All" ? {} : { facility: fac }) },
                              expected: { amount: v.amount, n: v.n, source: "Top-vendor extract", compare: false },
                            })
                          }
                        >
                          {v.vendor.replace(/\(IC Vendor\)/i, "").trim()}
                        </button>
                        {ic && <span className="badge ic">IC</span>}
                      </td>
                      <td className="t"><span className="sw" style={{ background: gcolor(v.group) }} /> {v.group}</td>
                      <td className="num">{usd(v.amount)}</td>
                      <td className="num">{v.n}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>Data quality &amp; exceptions</h2>
          <div className="small">
            {/* Gated on got.aa for the same reason every other figure on this
                page is: until agg_account lands, "$0 in 0 un-mapped accounts"
                is a confident claim that the taxonomy is clean, on the one
                panel whose job is to report that it is not. */}
            <div style={{ marginBottom: 8 }}>
              {got.aa ? (
                <>
                  <b>{usd(unclTot)}</b> in {exceptions.length} un-mapped accounts.
                </>
              ) : (
                <Sk className="sk-line" w="55%" />
              )}{" "}
              The <span className="mono">map_account_group</span> table holds the taxonomy; each upload rebuilds
              from it.
            </div>
            <div className="table-scroll">
              <table>
                <tbody>
                  {!got.aa && (
                    <tr><td style={{ padding: 0 }}><SkRows n={4} /></td></tr>
                  )}
                  {exceptions.slice(0, 6).map((a) => (
                    <tr key={a.account_label}>
                      <td className="t">
                        <button
                          className="dd-link"
                          onClick={() =>
                            openDrill({
                              title: a.account_label,
                              filters: { account_label: a.account_label },
                              expected: { amount: a.amount, n: a.n, source: "Account total (all facilities & months)", compare: true },
                            })
                          }
                        >
                          {a.account_label}
                        </button>
                      </td>
                      <td className="num">{usd(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, color: "var(--muted)" }}>
              Scope: expense + COGS only; income, equity draws and balance-sheet movement excluded. Only the
              expense/COGS side of each transaction is summed, so no double-count.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
