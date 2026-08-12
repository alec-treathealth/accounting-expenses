"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { GROUP_COLOR, GROUP_ORDER } from "@/lib/format";

// Cents matter here: three of the four unmapped accounts are under $1,000, and
// rounding them to whole dollars would hide exactly the materiality this screen
// exists to show.
const usdc = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type MapRow = {
  account_label: string;
  account_num: string | null;
  kpi_group: string;
  kind: string;
  reviewed: boolean;
};
type AggRow = { account_label: string; amount: number; n: number };
type Row = MapRow & { amount: number; n: number; inAgg: boolean };

type Probe = { fact_rows: number; agg_total: number };

const TOKEN_KEY = "aed_admin_token";
const cvar = (v: string) =>
  typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export default function MappingEditor() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [orphanAgg, setOrphanAgg] = useState<string[]>([]);

  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [gateErr, setGateErr] = useState("");

  const [filter, setFilter] = useState<"all" | "unclassified" | "unreviewed">("all");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<{ kind: "ok" | "warn" | "bad"; text: string } | null>(null);

  // ---- load the taxonomy + materiality (publishable key; both tables have a
  // read-only anon policy). Writes never go through this client.
  const load = useCallback(async () => {
    const sb = getSupabaseBrowser();
    const [m, a] = await Promise.all([
      sb.from("map_account_group").select("*").limit(2000),
      sb.from("agg_account").select("account_label,amount,n").limit(2000),
    ]);
    if (m.error) {
      setLoadErr(m.error.message);
      setLoaded(true);
      return;
    }
    const amounts = new Map<string, AggRow>(
      ((a.data as any[]) || []).map((r) => [r.account_label, { ...r, amount: Number(r.amount) }])
    );
    const map = (m.data as MapRow[]) || [];
    setRows(
      map.map((r) => {
        const agg = amounts.get(r.account_label);
        return { ...r, amount: agg ? agg.amount : 0, n: agg ? agg.n : 0, inAgg: !!agg };
      })
    );
    // Accounts with spend but no taxonomy row. rebuild_aggregates() seeds these,
    // so this should normally be empty; if it is not, say so rather than hide it.
    const mapped = new Set(map.map((r) => r.account_label));
    setOrphanAgg([...amounts.keys()].filter((k) => !mapped.has(k)));
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) setToken(saved);
  }, [load]);

  // ---- gated probe: fact_txn is private, so only the server can tell us
  // whether a rebuild would actually do anything.
  const runProbe = useCallback(async (t: string) => {
    setGateErr("");
    setProbe(null);
    try {
      const r = await fetch("/api/mapping", { headers: { "x-admin-token": t } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setGateErr(j.error || `probe failed (${r.status})`);
        return false;
      }
      setProbe({ fact_rows: j.fact_rows, agg_total: j.agg_total });
      return true;
    } catch (e: any) {
      setGateErr(e?.message || "probe failed");
      return false;
    }
  }, []);

  useEffect(() => {
    if (token) runProbe(token);
  }, [token, runProbe]);

  const unlock = async () => {
    const t = tokenInput.trim();
    if (!t) return;
    setBusy(true);
    const ok = await runProbe(t);
    setBusy(false);
    if (ok) {
      sessionStorage.setItem(TOKEN_KEY, t);
      setToken(t);
      setTokenInput("");
    }
  };

  const lock = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setProbe(null);
    setGateErr("");
  };

  const unlocked = !!token && !!probe;

  // ---- derived
  const totals = useMemo(() => {
    const unclassified = rows.filter((r) => r.kpi_group === "Unclassified expense");
    return {
      mapped: rows.length,
      amount: rows.reduce((s, r) => s + r.amount, 0),
      unreviewed: rows.filter((r) => !r.reviewed).length,
      unclassifiedN: unclassified.length,
      unclassifiedAmt: unclassified.reduce((s, r) => s + r.amount, 0),
    };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (filter === "unclassified" && r.kpi_group !== "Unclassified expense") return false;
        if (filter === "unreviewed" && r.reviewed) return false;
        if (needle && !r.account_label.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount) || x.account_label.localeCompare(y.account_label));
  }, [rows, filter, q]);

  // ---- mutations (always server-side, always with the admin token)
  const post = async (payload: Record<string, unknown>) => {
    const r = await fetch("/api/mapping", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": token },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
    return j;
  };

  const patchRow = async (label: string, patch: { kpi_group?: string; reviewed?: boolean }) => {
    const before = rows.find((r) => r.account_label === label);
    if (!before) return;
    setSaving((s) => ({ ...s, [label]: true }));
    setRowErr((e) => ({ ...e, [label]: "" }));
    // optimistic: setting a group marks the account reviewed, same as the server does
    setRows((rs) =>
      rs.map((r) =>
        r.account_label === label
          ? { ...r, ...patch, reviewed: patch.reviewed !== undefined ? patch.reviewed : true }
          : r
      )
    );
    try {
      const j = await post({ action: "update", account_label: label, ...patch });
      setRows((rs) => rs.map((r) => (r.account_label === label ? { ...r, ...j.row } : r)));
    } catch (e: any) {
      setRows((rs) => rs.map((r) => (r.account_label === label ? before : r))); // revert
      setRowErr((er) => ({ ...er, [label]: e?.message || "save failed" }));
    } finally {
      setSaving((s) => ({ ...s, [label]: false }));
    }
  };

  const rebuild = async () => {
    if (!confirm("Rebuild agg_group_month, agg_account and agg_vendor from fact_txn + this taxonomy?")) return;
    setBusy(true);
    setRebuildMsg(null);
    try {
      const j = await post({ action: "rebuild" });
      if (j.no_op) {
        setRebuildMsg({
          kind: "warn",
          text: `Rebuild ran but did nothing: fact_txn holds 0 transaction rows, so the guard in rebuild_aggregates() returned early and the live aggregates were left untouched. Dashboard total is still ${usdc(j.total)}. Ingest a CSV to make mapping edits take effect.`,
        });
      } else {
        setRebuildMsg({
          kind: "ok",
          text: `Rebuilt from ${Number(j.fact_rows).toLocaleString()} transaction rows. Dashboard total is now ${usdc(j.total)}.`,
        });
      }
      await runProbe(token);
      await load();
    } catch (e: any) {
      setRebuildMsg({ kind: "bad", text: e?.message || "rebuild failed" });
    } finally {
      setBusy(false);
    }
  };

  const sw = (g: string) => (
    <span className="sw" style={{ background: cvar(GROUP_COLOR[g] || "--g8") }} />
  );

  return (
    <>
      {/* ---- honest empty-state. Shown to everyone, sharpened once the probe
              can read the private fact_txn row count. ---- */}
      <div className="banner" style={{ marginTop: 14 }}>
        <b>What an edit here does — and does not — do.</b> Changing a group writes to{" "}
        <span className="mono">map_account_group</span> immediately, but the dashboard reads the{" "}
        <span className="mono">agg_*</span> tables, which only change when{" "}
        <span className="mono">rebuild_aggregates()</span> runs.{" "}
        {probe ? (
          probe.fact_rows === 0 ? (
            <>
              <b style={{ color: "var(--bad)" }}>
                Right now <span className="mono">fact_txn</span> holds 0 transaction rows
              </b>
              , so a rebuild is a guaranteed no-op and your edits will <b>not</b> move any number on
              the dashboard. They are saved and will apply the first time a CSV is ingested. Nothing
              on this page can change that.
            </>
          ) : (
            <>
              <span className="mono">fact_txn</span> holds{" "}
              <b>{probe.fact_rows.toLocaleString()}</b> transaction rows, so a rebuild will
              recompute the dashboard from this taxonomy.
            </>
          )
        ) : (
          <>
            The transaction table is private, so this page cannot check whether it has any rows until
            you unlock writes below.
          </>
        )}
      </div>

      {/* ---- write gate ---- */}
      <section className="card" style={{ marginTop: 12 }}>
        <h2>Write access</h2>
        {unlocked ? (
          <div className="small" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span className="status">
              <span className="dot live" />
              unlocked for this browser tab
            </span>
            <span style={{ color: "var(--muted)" }}>
              Edits and rebuilds are sent to <span className="mono">/api/mapping</span> and executed
              with the server-side service_role key.
            </span>
            <button onClick={lock}>Lock</button>
          </div>
        ) : (
          <div>
            <div className="small" style={{ marginBottom: 8, color: "var(--ink2)" }}>
              The table below is read-only until you enter the admin token (
              <span className="mono">ADMIN_API_TOKEN</span> on the server). It is held in this tab&apos;s
              sessionStorage only, and is never used to talk to Supabase directly.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlock()}
                placeholder="admin token"
                aria-label="Admin token"
                autoComplete="off"
                style={{
                  font: "inherit",
                  color: "var(--ink)",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "7px 10px",
                  minWidth: 260,
                }}
              />
              <button className="btn-primary" onClick={unlock} disabled={busy || !tokenInput.trim()}>
                {busy ? "Checking…" : "Unlock writes"}
              </button>
            </div>
            {gateErr && (
              <div className="small" style={{ marginTop: 8, color: "var(--bad)" }}>
                {gateErr}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ---- summary ---- */}
      <div className="grid kpis">
        <div className="card kpi">
          <div className="lab">Accounts in taxonomy</div>
          <div className="val">{totals.mapped}</div>
          <div className="foot">{usdc(totals.amount)} of spend</div>
        </div>
        <div className="card kpi">
          <div className="lab">Unclassified</div>
          <div className="val">{totals.unclassifiedN}</div>
          <div className="foot">{usdc(totals.unclassifiedAmt)} needs a group</div>
        </div>
        <div className="card kpi">
          <div className="lab">Not yet reviewed</div>
          <div className="val">{totals.unreviewed}</div>
          <div className="foot">of {totals.mapped} accounts</div>
        </div>
        <div className="card kpi">
          <div className="lab">Rebuild</div>
          <div className="val" style={{ fontSize: 15, fontWeight: 600, marginTop: 6 }}>
            <button className="btn-primary" onClick={rebuild} disabled={!unlocked || busy}>
              {busy ? "Working…" : "Rebuild aggregates"}
            </button>
          </div>
          <div className="foot">{unlocked ? "service_role, server-side" : "unlock writes first"}</div>
        </div>
      </div>

      {rebuildMsg && (
        <div
          className="banner"
          style={{
            borderColor: rebuildMsg.kind === "bad" ? "var(--bad)" : undefined,
            color: rebuildMsg.kind === "bad" ? "var(--bad)" : undefined,
          }}
        >
          {rebuildMsg.text}
        </div>
      )}

      {orphanAgg.length > 0 && (
        <div className="banner" style={{ borderColor: "var(--bad)" }}>
          <b>{orphanAgg.length}</b> account(s) have spend in <span className="mono">agg_account</span>{" "}
          but no <span className="mono">map_account_group</span> row, so they cannot be edited here
          yet: <span className="mono">{orphanAgg.slice(0, 5).join(", ")}</span>. A rebuild seeds them
          into the taxonomy.
        </div>
      )}

      {/* ---- the editor ---- */}
      <section className="card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0 }}>Accounts by materiality</h2>
          <div className="controls">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search account…"
              aria-label="Search account"
              style={{
                font: "inherit",
                color: "var(--ink)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "7px 10px",
              }}
            />
            <select value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Filter">
              <option value="all">All accounts ({rows.length})</option>
              <option value="unclassified">Unclassified only ({totals.unclassifiedN})</option>
              <option value="unreviewed">Not reviewed ({totals.unreviewed})</option>
            </select>
          </div>
        </div>

        {!loaded && <div className="small">Loading…</div>}
        {loadErr && (
          <div className="small" style={{ color: "var(--bad)" }}>
            Could not read the taxonomy: {loadErr}
          </div>
        )}

        {loaded && !loadErr && (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Account (name is the key)</th>
                  <th>Kind</th>
                  <th className="num">Amount</th>
                  <th className="num">Txns</th>
                  <th>KPI group</th>
                  <th>Reviewed</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.account_label}>
                    <td className="t">
                      {r.account_label}
                      {!r.inAgg && (
                        <span className="badge" title="No rows in agg_account — no spend recorded">
                          no spend
                        </span>
                      )}
                      {rowErr[r.account_label] && (
                        <div className="small" style={{ color: "var(--bad)" }}>
                          {rowErr[r.account_label]}
                        </div>
                      )}
                    </td>
                    <td className="t" style={{ color: "var(--muted)" }}>
                      {r.kind}
                    </td>
                    <td className="num">{usdc(r.amount)}</td>
                    <td className="num">{r.n}</td>
                    <td className="t">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {sw(r.kpi_group)}
                        <select
                          value={r.kpi_group}
                          disabled={!unlocked || !!saving[r.account_label]}
                          aria-label={`KPI group for ${r.account_label}`}
                          onChange={(e) => patchRow(r.account_label, { kpi_group: e.target.value })}
                        >
                          {GROUP_ORDER.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                      </span>
                    </td>
                    <td className="t">
                      {saving[r.account_label] ? (
                        <span className="small" style={{ color: "var(--muted)" }}>
                          saving…
                        </span>
                      ) : r.reviewed ? (
                        <span className="badge" style={{ color: "var(--good)", borderColor: "var(--good)" }}>
                          reviewed
                        </span>
                      ) : (
                        <button
                          onClick={() => patchRow(r.account_label, { reviewed: true })}
                          disabled={!unlocked}
                          title="Confirm this mapping is correct without changing it"
                          style={{ padding: "3px 8px", fontSize: 11.5 }}
                        >
                          Confirm
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td className="t" colSpan={6} style={{ color: "var(--muted)" }}>
                      Nothing matches this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="small" style={{ marginTop: 12, color: "var(--muted)" }}>
          Accounts are keyed by <b>name</b>, never by number: numbers collide across the 80+
          consolidated entities (7040 is “Payroll Taxes” in one entity and “Income from Capital One”
          in another). <b>Kind</b> (COGS vs EXP) is derived from the source account class and is not
          editable here — changing a KPI group never changes it, and never changes an amount. A
          rebuild only ever reallocates spend between groups; the grand total is asserted to tie back
          to <span className="mono">fact_txn</span> to the penny, and the rebuild aborts if it does
          not.
        </div>
      </section>
    </>
  );
}
