"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { usd, usdShort, pct, GROUP_COLOR, GROUP_ORDER, MONTH_LABEL } from "@/lib/format";
import TxnDrawer, { type DrillContext, type DrillFilters } from "@/components/TxnDrawer";

type GM = { facility: string; posted_period: string; kpi_group: string; amount: number; n: number };
type AA = { account_label: string; account_num: string | null; kpi_group: string; kind: string; amount: number; n: number };
type AV = { facility: string; vendor: string; kpi_group: string; amount: number; n: number };
type FAC = { facility: string; entity_raw: string; in_scope: boolean; note: string | null };

const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const cvar = (v: string) => (typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(v).trim());
const gcolor = (g: string) => cvar(GROUP_COLOR[g] || "--g8");

export default function Dashboard({ reloadKey }: { reloadKey: number }) {
  const [gm, setGm] = useState<GM[]>([]);
  const [aa, setAa] = useState<AA[]>([]);
  const [av, setAv] = useState<AV[]>([]);
  const [dim, setDim] = useState<FAC[]>([]);
  const [live, setLive] = useState(false);
  const [fac, setFac] = useState("All");
  const [mon, setMon] = useState("All");
  const [, force] = useState(0);
  const [drill, setDrill] = useState<DrillContext | null>(null);

  useEffect(() => {
    let ok = true;
    (async () => {
      const sb = getSupabaseBrowser();
      const [g, a, v, f] = await Promise.all([
        sb.from("agg_group_month").select("*").limit(5000),
        sb.from("agg_account").select("*").limit(2000),
        sb.from("agg_vendor").select("*").limit(5000),
        sb.from("dim_facility").select("*").limit(100),
      ]);
      if (!ok) return;
      if (g.data) {
        setGm(g.data.map((r: any) => ({ ...r, posted_period: String(r.posted_period).slice(0, 7), amount: +r.amount })));
        setLive(true);
      }
      if (a.data) setAa(a.data.map((r: any) => ({ ...r, amount: +r.amount })));
      if (v.data) setAv(v.data.map((r: any) => ({ ...r, amount: +r.amount })));
      if (f.data) setDim(f.data as FAC[]);
    })();
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

  const theme = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme:dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    force((x) => x + 1);
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
          <button onClick={theme} aria-label="Toggle theme">◐ Theme</button>
        </div>
      </header>

      {Math.abs(unclTot) > 0 && (
        <div className="banner">
          <b>Read with care.</b> {usd(unclTot)} sits in un-mapped/unclassified accounts (see data-quality panel). Totals reconcile to the source report to the penny.
        </div>
      )}

      <div className="grid kpis">
        <div className="card kpi">
          <div className="lab">Total spend</div><div className="val">{usd(total)}</div>
          <div className="foot">{mon === "All" ? "Apr–Aug 2026 (Aug partial)" : MONTH_LABEL[mon] + " 2026"}</div>
          <div className="dd-hint">
            {fac === "All" && mon === "All"
              ? "Filter by facility or month to drill down"
              : <button className="dd-link" onClick={() => openAgg(scope(), "Total spend")}>View transactions</button>}
          </div>
        </div>
        <div className="card kpi">
          <div className="lab">Largest group</div><div className="val">{usd(big[1] as number)}</div>
          <div className="foot">{big[0]} · {pct((big[1] as number) / (total || 1))}</div>
          <div className="dd-hint">
            {big[1] ? <button className="dd-link" onClick={() => openAgg({ ...scope(), kpi_group: String(big[0]) }, String(big[0]))}>View transactions</button> : "—"}
          </div>
        </div>
        <div className="card kpi"><div className="lab">Facilities reporting</div><div className="val">{reporting}{fac === "All" ? ` of ${rosterCount}` : ""}</div><div className="foot">{fac !== "All" ? fac : silent.length ? `${silent.join(", ")} ${silent.length === 1 ? "has" : "have"} no expense accounts` : "all facilities reporting"}</div></div>
        <div className="card kpi"><div className="lab">Avg / full month</div><div className="val">{usd(avgFull)}</div><div className="foot">Apr–Jul, excludes partial Aug</div></div>
      </div>

      <section className="two">
        <div className="card">
          <h2>Spend by KPI group <span className="dd-dim" style={{ fontWeight: 400 }}>· click a bar for transactions</span></h2>
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
          {[0, 1, 2, 3, 4].map((i) => { const y = padT + (H - padT - padB) * i / 4; return <line key={i} x1={8} x2={W} y1={y} y2={y} stroke="var(--grid)" strokeWidth={1} />; })}
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
                <text x={x + bw / 2} y={H - 9} textAnchor="middle" fontSize={11} fill="var(--muted)">{MONTH_LABEL[mo]}</text>
                <text x={x + bw / 2} y={tTop} textAnchor="middle" fontSize={10.5} fill="var(--ink2)" className="mono">{usdShort(stack.totals[i])}</text>
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
