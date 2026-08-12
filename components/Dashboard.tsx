"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { usd, usdShort, pct, GROUP_COLOR, GROUP_ORDER, MONTH_LABEL } from "@/lib/format";
import TxnDrawer, { type DrillContext, type DrillFilters } from "@/components/TxnDrawer";
import { usePrefs } from "@/components/usePrefs";

type GM = { facility: string; posted_period: string; kpi_group: string; amount: number; n: number };
type AA = { account_label: string; account_num: string | null; kpi_group: string; kind: string; amount: number; n: number };
type AV = { facility: string; vendor: string; kpi_group: string; amount: number; n: number };
type FAC = { facility: string; entity_raw: string; in_scope: boolean; note: string | null };

const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

/* A KPI group's color is the design-system chart-series custom property, used
   as a CSS value rather than a resolved hex. This used to read the computed
   value off <html> and force a re-render on every theme flip, because a
   snapshot hex cannot follow the ground; `var()` follows it for free, in CSS,
   with no React involvement. SVG `fill` accepts it exactly like `background`. */
const gcolor = (g: string) => `var(${GROUP_COLOR[g] ?? "--chart-8"})`;

/* Staggered entrance. `ths-rise` has fill-mode `both`, so a delay holds the
   element at its from-state until its turn and the row reads as one movement
   rather than four simultaneous pops. Both the OS reduced-motion setting and
   the in-app Motion switch collapse this to ~0ms in components.css, so this is
   safe to apply unconditionally. */
const rise = (i: number) => ({ animationDelay: `${i * 45}ms` });

/** Shimmer placeholder for a figure that has not arrived yet.
 *  Never render a zero while loading: on a financial dashboard "$0" is a
 *  claim about the business, not a loading state. */
function Sk({ className = "", w }: { className?: string; w?: number | string }) {
  return (
    <span
      className={`ths-skeleton ${className}`}
      style={{ display: "block", width: w }}
      aria-hidden="true"
    />
  );
}

/** Placeholder bar rows, sized like the real ones so nothing shifts on arrival. */
function SkRows({ n }: { n: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading figures…</span>
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          <Sk className="sk-line" w={`${58 + ((i * 13) % 34)}%`} />
          <Sk className="sk-line" />
          <Sk className="sk-line" w="70%" />
        </div>
      ))}
    </div>
  );
}

export default function Dashboard({ reloadKey }: { reloadKey: number }) {
  const [gm, setGm] = useState<GM[]>([]);
  const [aa, setAa] = useState<AA[]>([]);
  const [av, setAv] = useState<AV[]>([]);
  const [dim, setDim] = useState<FAC[]>([]);
  const [live, setLive] = useState(false);
  const [fac, setFac] = useState("All");
  const [mon, setMon] = useState("All");
  const [drill, setDrill] = useState<DrillContext | null>(null);
  /* Per-dataset arrival, not one global flag. The four reads are independent,
     so a panel should render the moment ITS data lands instead of every panel
     waiting on the slowest query. `gm` gates the figures that must reconcile;
     `av` and `aa` gate their own panels. */
  const [got, setGot] = useState({ gm: false, aa: false, av: false, dim: false });
  const [loadError, setLoadError] = useState<string | null>(null);

  const { ground, density, motion, toggleGround, setDensity, setMotion } = usePrefs();

  useEffect(() => {
    let ok = true;
    const sb = getSupabaseBrowser();
    setLoadError(null);

    // Fire all four together, but resolve them independently so each panel
    // streams in. Promise.all would gate the whole page on the slowest read.
    const fail = (what: string) => (e: unknown) => {
      if (!ok) return;
      // Generic to the user, specific in the console — the message can carry
      // PostgREST detail we do not want rendered into the page.
      console.error(`[dashboard] ${what} read failed`, e);
      setLoadError("Could not load some figures. Refresh to retry.");
    };

    sb.from("agg_group_month").select("*").limit(5000).then(({ data, error }) => {
      if (!ok) return;
      if (error) return fail("agg_group_month")(error);
      setGm((data ?? []).map((r: any) => ({ ...r, posted_period: String(r.posted_period).slice(0, 7), amount: +r.amount })));
      setLive(true);
      setGot((s) => ({ ...s, gm: true }));
    }, fail("agg_group_month"));

    sb.from("agg_account").select("*").limit(2000).then(({ data, error }) => {
      if (!ok) return;
      if (error) return fail("agg_account")(error);
      setAa((data ?? []).map((r: any) => ({ ...r, amount: +r.amount })));
      setGot((s) => ({ ...s, aa: true }));
    }, fail("agg_account"));

    sb.from("agg_vendor").select("*").limit(5000).then(({ data, error }) => {
      if (!ok) return;
      if (error) return fail("agg_vendor")(error);
      setAv((data ?? []).map((r: any) => ({ ...r, amount: +r.amount })));
      setGot((s) => ({ ...s, av: true }));
    }, fail("agg_vendor"));

    sb.from("dim_facility").select("*").limit(100).then(({ data, error }) => {
      if (!ok) return;
      if (error) return fail("dim_facility")(error);
      setDim((data ?? []) as FAC[]);
      setGot((s) => ({ ...s, dim: true }));
    }, fail("dim_facility"));

    return () => { ok = false; };
  }, [reloadKey]);

  // dim_facility is the roster; agg_group_month only has facilities that spent
  // something. A facility with no expense accounts in the export must still be
  // listed, so the count can't come from the aggregates alone.
  const inScope = useMemo(() => dim.filter((d) => d.in_scope), [dim]);
  const notes = useMemo(() => dim.filter((d) => d.note), [dim]);

  const facilities = useMemo(() => {
    const s = new Set(gm.map((r) => r.facility));
    inScope.forEach((d) => s.add(d.facility));
    return [...s].sort();
  }, [gm, inScope]);

  // in-scope facilities carrying no spend at all — named rather than assumed
  const silent = useMemo(() => {
    const spending = new Set(gm.map((r) => r.facility));
    return inScope.filter((d) => !spending.has(d.facility)).map((d) => d.facility);
  }, [inScope, gm]);

  const rows = useMemo(
    () => gm.filter((r) => (fac === "All" || r.facility === fac) && (mon === "All" || r.posted_period === mon)),
    [gm, fac, mon]
  );

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const byGroup = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { m[r.kpi_group] = (m[r.kpi_group] || 0) + r.amount; });
    return Object.entries(m).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const byFac = useMemo(() => {
    const m: Record<string, number> = {};
    gm.filter((r) => mon === "All" || r.posted_period === mon).forEach((r) => { m[r.facility] = (m[r.facility] || 0) + r.amount; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [gm, mon]);

  // --- transaction drill-down -----------------------------------------------
  // Clicking a figure opens the underlying fact_txn rows via /api/txn (server
  // only). Drills inherit the dashboard's current facility/month filters, and
  // carry the on-screen figure so the panel can prove the rows sum to it.
  const aggFor = (f: DrillFilters) => {
    let amount = 0;
    let n = 0;
    gm.forEach((r) => {
      if (f.facility && r.facility !== f.facility) return;
      if (f.month && r.posted_period !== f.month) return;
      if (f.kpi_group && r.kpi_group !== f.kpi_group) return;
      amount += r.amount;
      n += r.n;
    });
    return { amount: Math.round(amount * 100) / 100, n };
  };
  const scope = (): DrillFilters => ({
    ...(fac === "All" ? {} : { facility: fac }),
    ...(mon === "All" ? {} : { month: mon }),
  });
  // agg_group_month covers the full population, so its figure is comparable.
  const openAgg = (filters: DrillFilters, title: string) => {
    const a = aggFor(filters);
    setDrill({ title, filters, expected: { amount: a.amount, n: a.n, source: "Dashboard figure", compare: true } });
  };

  const big = byGroup[0] || ["—", 0];
  const avgFull = rows.filter((r) => r.posted_period !== "2026-08").reduce((s, r) => s + r.amount, 0) / 4;
  const reporting = new Set(rows.map((r) => r.facility)).size;

  // vendors
  const vendors = useMemo(() => {
    const rs = av.filter((v) => fac === "All" || v.facility === fac);
    const agg: Record<string, { vendor: string; group: string; amount: number; n: number }> = {};
    rs.forEach((v) => {
      const k = v.vendor + "||" + v.kpi_group;
      agg[k] = agg[k] || { vendor: v.vendor, group: v.kpi_group, amount: 0, n: 0 };
      agg[k].amount += v.amount; agg[k].n += v.n;
    });
    return Object.values(agg).sort((a, b) => b.amount - a.amount).slice(0, 15);
  }, [av, fac]);

  const exceptions = useMemo(
    () => aa.filter((a) => a.kpi_group === "Unclassified expense" || a.kpi_group === "Unmapped").sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    [aa]
  );
  const unclTot = exceptions.reduce((s, r) => s + r.amount, 0);

  // monthly stack
  const stack = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    MONTHS.forEach((mo) => (m[mo] = {}));
    gm.filter((r) => fac === "All" || r.facility === fac).forEach((r) => { m[r.posted_period][r.kpi_group] = (m[r.posted_period][r.kpi_group] || 0) + r.amount; });
    const totals = MONTHS.map((mo) => GROUP_ORDER.reduce((a, g) => a + (m[mo][g] || 0), 0));
    return { m, totals, max: Math.max(...totals, 1) };
  }, [gm, fac]);

  // fall back to whatever the aggregates show until dim_facility has loaded, so
  // the header never flashes "0 residential facilities"
  const rosterCount = inScope.length || facilities.length;

  const gmax = Math.max(...byGroup.map((g) => Math.abs(g[1])), 1);
  const fmax = Math.max(...byFac.map((f) => Math.abs(f[1])), 1);

  const W = 680, H = 210, padB = 26, padT = 8, gap = (W - 8) / MONTHS.length, bw = Math.min(66, gap - 14);

  return (
    <>
      <header className="top">
        <div>
          <h1>Treat Health — Expense Dashboard</h1>
          <div className="sub">
            {rosterCount} residential facilities · Apr 1 – Aug 11 2026 (August partial) ·{" "}
            <span className="status"><span className={"dot" + (live ? " live" : "")} />{live ? "live" : "connecting…"}</span>
          </div>
        </div>
        <div className="controls">
          <select aria-label="Facility" value={fac} onChange={(e) => setFac(e.target.value)}>
            <option value="All">All facilities</option>
            {facilities.map((x) => <option key={x}>{x}</option>)}
          </select>
          <select aria-label="Month" value={mon} onChange={(e) => setMon(e.target.value)}>
            <option value="All">All months</option>
            {MONTHS.map((x) => <option key={x} value={x}>{x === "2026-08" ? "August (partial)" : new Date(x + "-01").toLocaleString("en-US", { month: "long" })} 2026</option>)}
          </select>

          {/* Display preferences are design-system grounds, not a bespoke theme:
              each one just sets a data attribute on <html> and every token
              re-resolves. Density matters on this screen specifically — an
              accountant reconciling 402 rows wants compact; a review meeting
              on a projector wants comfortable. */}
          <div className="seg" role="radiogroup" aria-label="Density">
            {(["compact", "comfortable"] as const).map((d) => (
              <label key={d} className="seg-opt">
                <input type="radio" name="ths-density" checked={density === d} onChange={() => setDensity(d)} />
                {d === "compact" ? "Compact" : "Comfortable"}
              </label>
            ))}
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={toggleGround}
            aria-label={`Switch to ${ground === "dark" ? "light" : "dark"} ground`}
          >
            ◐ {ground === "dark" ? "Light" : "Dark"}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setMotion(motion === "on" ? "off" : "on")}
            aria-pressed={motion === "off"}
            title="Stop dashboard animation. Reduced-motion OS settings are always honoured regardless of this switch."
          >
            {motion === "on" ? "Motion on" : "Motion off"}
          </button>
        </div>
      </header>

      {loadError && (
        <div className="dd-warn" role="alert" style={{ marginTop: "var(--space-4)" }}>{loadError}</div>
      )}

      {Math.abs(unclTot) > 0 && (
        <div className="banner">
          <b>Read with care.</b> {usd(unclTot)} sits in un-mapped/unclassified accounts (see data-quality panel). Totals reconcile to the source report to the penny.
        </div>
      )}

      <div className="grid kpis">
        <div className="card kpi ths-rise" style={rise(0)}>
          <div className="lab">Total spend</div>
          <div className="val">{got.gm ? usd(total) : <Sk className="sk-kpi" />}</div>
          <div className="foot">{mon === "All" ? "Apr–Aug 2026 (Aug partial)" : MONTH_LABEL[mon] + " 2026"}</div>
          <div className="dd-hint">
            {fac === "All" && mon === "All"
              ? "Filter by facility or month to drill down"
              : <button className="dd-link" onClick={() => openAgg(scope(), "Total spend")}>View transactions</button>}
          </div>
        </div>
        <div className="card kpi ths-rise" style={rise(1)}>
          <div className="lab">Largest group</div>
          <div className="val">{got.gm ? usd(big[1] as number) : <Sk className="sk-kpi" />}</div>
          <div className="foot">{got.gm ? `${big[0]} · ${pct((big[1] as number) / (total || 1))}` : " "}</div>
          <div className="dd-hint">
            {big[1] ? <button className="dd-link" onClick={() => openAgg({ ...scope(), kpi_group: String(big[0]) }, String(big[0]))}>View transactions</button> : "—"}
          </div>
        </div>
        {/* Roster vs reporting. These are different questions and the card used
            to blur them: every in-scope facility IS counted in the denominator,
            including the ones with no expense accounts in this export. Saying
            "all N in scope" up front stops "13 of 15" reading as though two
            facilities had been dropped. See the data-quality panel for why each
            silent facility is silent — the two reasons are not the same. */}
        <div className="card kpi ths-rise" style={rise(2)}>
          <div className="lab">Facilities reporting</div>
          <div className="val">{got.gm ? <>{reporting}{fac === "All" ? ` of ${rosterCount}` : ""}</> : <Sk className="sk-kpi" />}</div>
          <div className="foot">
            {fac !== "All"
              ? fac
              : silent.length
                ? `all ${rosterCount} in scope · ${silent.length} with no expense accounts in this export`
                : `all ${rosterCount} in scope and reporting`}
          </div>
        </div>
        <div className="card kpi ths-rise" style={rise(3)}>
          <div className="lab">Avg / full month</div>
          <div className="val">{got.gm ? usd(avgFull) : <Sk className="sk-kpi" />}</div>
          <div className="foot">Apr–Jul, excludes partial Aug</div>
        </div>
      </div>

      <section className="two">
        <div className="card">
          <h2>Spend by KPI group <span className="dd-dim" style={{ fontWeight: 400 }}>· click a bar for transactions</span></h2>
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
              <div className="track"><div className="fill" style={{ width: (Math.abs(v as number) / gmax) * 100 + "%", background: gcolor(g) }} /></div>
              <div className="bar-val">{usd(v as number)} <span className="bar-sub">{pct((v as number) / (total || 1))}</span></div>
            </button>
          ))}
        </div>
        <div className="card">
          <h2>Spend by facility <span className="dd-dim" style={{ fontWeight: 400 }}>· click a bar for transactions</span></h2>
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
              <div className="track"><div className="fill" style={{ width: (Math.abs(v as number) / fmax) * 100 + "%", background: "var(--seq)", opacity: f === fac ? 1 : 0.85 }} /></div>
              <div className="bar-val">{usd(v as number)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Monthly spend by group{fac === "All" ? "" : " — " + fac}</h2>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monthly spend by group">
          {[0, 1, 2, 3, 4].map((i) => { const y = padT + (H - padT - padB) * i / 4; return <line key={i} x1={8} x2={W} y1={y} y2={y} stroke="var(--chart-grid)" strokeWidth={1} />; })}
          {MONTHS.map((mo, i) => {
            const x = 8 + gap * i + (gap - bw) / 2;
            let yTop = H - padB;
            const rects = GROUP_ORDER.map((g) => {
              const val = stack.m[mo][g] || 0; if (val <= 0) return null;
              const h = (H - padT - padB) * val / stack.max; yTop -= h;
              const open = () => openAgg({ ...(fac === "All" ? {} : { facility: fac }), month: mo, kpi_group: g }, `${MONTH_LABEL[mo]} 2026 · ${g}`);
              return (
                <rect
                  key={g} x={x} y={yTop} width={bw} height={Math.max(h - 2, 0)} fill={gcolor(g)} rx={1.5}
                  className="dd-seg" role="button" tabIndex={0}
                  aria-label={`${MONTH_LABEL[mo]} ${g}, ${usd(val)}. View transactions`}
                  onClick={open}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
                ><title>{MONTH_LABEL[mo]} · {g}: {usd(val)} — click to view transactions</title></rect>
              );
            });
            const tTop = (H - padB) - (H - padT - padB) * stack.totals[i] / stack.max - 5;
            return (
              <g key={mo}>
                {rects}
                <text x={x + bw / 2} y={H - 9} textAnchor="middle" fontSize={11} fill="var(--text-meta)">{MONTH_LABEL[mo]}</text>
                <text x={x + bw / 2} y={tTop} textAnchor="middle" fontSize={10.5} fill="var(--text-secondary)" className="mono">{usdShort(stack.totals[i])}</text>
              </g>
            );
          })}
        </svg>
        <div className="legend">
          {GROUP_ORDER.map((g) => <span key={g}><span className="sw" style={{ background: gcolor(g) }} />{g}</span>)}
          <span style={{ color: "var(--muted)" }}>* August partial (through Aug 11)</span>
        </div>
      </section>

      <section className="two">
        <div className="card">
          <h2>Top vendors{fac === "All" ? " (all facilities)" : " — " + fac}</h2>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Vendor</th><th>Group</th><th className="num">Amount</th><th className="num">Txns</th></tr></thead>
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
                          onClick={() => setDrill({
                            title: `${v.vendor} · ${v.group}`,
                            filters: { vendor: v.vendor, kpi_group: v.group, ...(fac === "All" ? {} : { facility: fac }) },
                            expected: { amount: v.amount, n: v.n, source: "Top-vendor extract", compare: false },
                          })}
                        >{v.vendor.replace(/\(IC Vendor\)/i, "").trim()}</button>
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
            <div style={{ marginBottom: 8 }}><b>{usd(unclTot)}</b> in {exceptions.length} un-mapped accounts. The <span className="mono">map_account_group</span> table holds the taxonomy; each upload rebuilds from it.</div>
            <table><tbody>{exceptions.slice(0, 6).map((a) => (
              <tr key={a.account_label}>
                <td className="t">
                  <button
                    className="dd-link"
                    onClick={() => setDrill({
                      title: a.account_label,
                      filters: { account_label: a.account_label },
                      expected: { amount: a.amount, n: a.n, source: "Account total (all facilities & months)", compare: true },
                    })}
                  >{a.account_label}</button>
                </td>
                <td className="num">{usd(a.amount)}</td>
              </tr>
            ))}</tbody></table>
            {notes.map((f) => <div key={f.facility} style={{ marginTop: 10, paddingLeft: 10, borderLeft: "2px solid var(--axis)" }}><b>{f.facility}:</b> {f.note}</div>)}
            <div style={{ marginTop: 10, color: "var(--muted)" }}>Scope: expense + COGS only; income, equity draws and balance-sheet movement excluded. Only the expense/COGS side of each transaction is summed, so no double-count.</div>
          </div>
        </div>
      </section>

      <footer>
        Source: “Consolidated transaction detail” export (QuickBooks) · Warehouse: Supabase <span className="mono">accounting-expenses</span> · Totals reconcile to source to the penny.
      </footer>

      {drill && <TxnDrawer ctx={drill} onClose={() => setDrill(null)} />}
    </>
  );
}
