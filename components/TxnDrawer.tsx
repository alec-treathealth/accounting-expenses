"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usdExact } from "@/lib/format";
/* Type-and-constant only: lib/txnQuery.ts is pure query-building with no
   server-only imports, so sharing MAX_Q keeps the input's maxLength and the
   server's cap from drifting apart. The server still enforces it — this is
   only the affordance. */
import { MAX_Q } from "@/lib/txnQuery";

// Transaction drill-down panel. Reads /api/txn (server-only, service_role,
// gated) — never fact_txn directly, which is private by design.

export type DrillFilters = {
  facility?: string;
  month?: string; // YYYY-MM
  kpi_group?: string;
  account_label?: string;
  vendor?: string;
  /** Restrict to Ramp card charges. Cannot stand alone — see filter_required. */
  ramp?: boolean;
  /** Ramp cardholder. Implies `ramp` server-side. */
  person?: string;
};

export type DrillContext = {
  /** Human-readable filter context shown in the panel header. */
  title: string;
  filters: DrillFilters;
  /**
   * The figure the user clicked, so the panel can prove the detail reconciles.
   * `compare: false` for figures drawn from a partial extract (agg_vendor is
   * top-150 only), where a difference is expected and must not be alarming.
   */
  expected?: { amount: number; n: number; source: string; compare: boolean } | null;
};

type TxnRow = {
  row_key: string;
  occurrence: number;
  facility: string;
  txn_date: string;
  txn_type: string | null;
  num: string | null;
  name: string | null;
  description: string | null;
  account_label: string;
  kpi_group: string;
  amount: number;
};

type Payload = {
  rows: TxnRow[];
  page: { limit: number; offset: number; returned: number };
  totals: { amount: number | null; count: number; exact: boolean };
  truncated: boolean;
  detail_available: boolean;
  /** The server echoes the sanitized search term and whether one was applied. */
  filters?: { q?: string | null; searched?: boolean };
};

const SORTABLE = { txn_date: "Date", amount: "Amount" } as const;
type Sort = keyof typeof SORTABLE;

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export default function TxnDrawer({ ctx, onClose }: { ctx: DrillContext; onClose: () => void }) {
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<Sort>("txn_date");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState(true);
  /* Two pieces of search state on purpose: `draft` is what the box shows and
     `q` is what has been sent. Searching on every keystroke would fire a paged
     COUNT plus a chunked SUM over fact_txn per character; debouncing the
     committed value keeps that to one round-trip per pause. */
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const key = JSON.stringify(ctx.filters);
  // A new search is a new population, so it must restart at page 1 — otherwise
  // an offset from the previous result set silently hides matching rows.
  useEffect(() => setOffset(0), [key, limit, sort, dir, q]);

  useEffect(() => {
    const t = setTimeout(() => setQ(draft.trim()), 260);
    return () => clearTimeout(t);
  }, [draft]);

  // Focus management: move focus into the dialog, lock background scroll, and
  // hand focus back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    // Escape is bound on the document, not the panel: a control that disables
    // itself while loading drops focus to <body>, and a panel-scoped handler
    // would then never see the key.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("keydown", onEsc);
      document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);

  // Keep focus inside the dialog if a control disabled itself out from under it.
  useEffect(() => {
    if (busy) return;
    if (!document.activeElement || document.activeElement === document.body) panelRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    const ac = new AbortController();
    const qs = new URLSearchParams();
    const f = ctx.filters;
    if (f.facility) qs.set("facility", f.facility);
    if (f.month) qs.set("month", f.month);
    if (f.kpi_group) qs.set("kpi_group", f.kpi_group);
    if (f.account_label) qs.set("account_label", f.account_label);
    if (f.vendor) qs.set("vendor", f.vendor);
    if (f.ramp) qs.set("ramp", "1");
    if (f.person) qs.set("person", f.person);
    if (q) qs.set("q", q);
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));
    qs.set("sort", sort);
    qs.set("dir", dir);

    setBusy(true);
    setErr(null);
    (async () => {
      try {
        const res = await fetch(`/api/txn?${qs.toString()}`, {
          signal: ac.signal,
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        const body = await res.json().catch(() => null);
        if (ac.signal.aborted) return;
        if (!res.ok) {
          setData(null);
          setErr({ status: res.status, message: (body && (body.message || body.error)) || res.statusText });
        } else {
          setData(body as Payload);
        }
      } catch (e) {
        if (!ac.signal.aborted) setErr({ status: 0, message: "Network error reading transaction detail." });
      } finally {
        if (!ac.signal.aborted) setBusy(false);
      }
    })();
    return () => ac.abort();
  }, [key, limit, offset, sort, dir, q, ctx.filters]);

  // Tab trap. Escape is handled on the document (see above).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const chips = useMemo(() => {
    const f = ctx.filters;
    const out: string[] = [];
    if (f.facility) out.push(f.facility);
    if (f.month) out.push(f.month);
    if (f.kpi_group) out.push(f.kpi_group);
    if (f.account_label) out.push(f.account_label);
    if (f.vendor) out.push(f.vendor);
    /* A person already implies the Ramp restriction, so showing both chips
       would read as two filters where there is one. */
    if (f.person) out.push(f.person);
    else if (f.ramp) out.push("Ramp card");
    return out;
  }, [ctx.filters]);

  const totals = data?.totals;
  const count = totals?.count ?? 0;
  const detailTotal = totals?.exact ? totals.amount : null;
  const expected = ctx.expected || null;

  /* A search makes the rows a SUBSET of the drilled slice, so the totals stop
     being comparable to the dashboard figure — they are now "the searched
     part of it". Trust the server's echo over local state: `searched` reflects
     the term that actually ran after sanitizing, so a term reduced to nothing
     correctly keeps full reconciliation instead of silently disabling it.
     Without this, typing in the box would fire "Does not reconcile" on a
     perfectly reconciled dataset — turning the drawer's most valuable signal
     into noise. */
  const searched = data?.filters?.searched ?? false;
  const effectiveQ = data?.filters?.q ?? null;
  const compare = Boolean(expected && expected.compare && !searched);
  const diff = compare && detailTotal !== null ? detailTotal - expected!.amount : 0;
  const reconciles = Math.abs(diff) < 0.005;
  /* Punctuation is stripped before the term reaches the database (it is
     interpolated into a PostgREST or= filter). Say so when it happened, rather
     than appearing to ignore what was typed. */
  const termAltered = searched && effectiveQ !== null && effectiveQ !== draft.trim();
  const showing = data && data.rows.length > 0 ? `${offset + 1}–${offset + data.rows.length}` : "0";

  const setSortKey = (k: Sort) => {
    if (k === sort) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(k);
      setDir(k === "amount" ? "desc" : "asc");
    }
  };

  return (
    <div className="dd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="dd-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dd-title"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="dd-head">
          <div className="dd-head-row">
            <div>
              <h2 id="dd-title" className="dd-title">Transaction detail — {ctx.title}</h2>
              <div className="dd-chips">
                {chips.map((c) => <span className="dd-chip" key={c}>{c}</span>)}
                {chips.length === 0 && <span className="dd-chip">no filter</span>}
              </div>
            </div>
            <button ref={closeRef} className="dd-close" onClick={onClose} aria-label="Close transaction detail">
              ✕
            </button>
          </div>

          <div className="dd-recon" aria-live="polite">
            <span>
              Rows <b className="mono">{busy && !data ? "…" : count.toLocaleString()}</b>
            </span>
            <span>
              Detail total{" "}
              <b className="mono">
                {busy && !data ? "…" : detailTotal === null ? "not totalled" : usdExact(detailTotal)}
              </b>
            </span>
            {expected && (
              <span>
                {expected.source} <b className="mono">{usdExact(expected.amount)}</b>
                {expected.n ? <span className="dd-dim"> · {expected.n.toLocaleString()} txns</span> : null}
              </span>
            )}
            {searched && (
              <span className="dd-dim">
                matching “{effectiveQ}” — a subset of this slice, not the whole figure
              </span>
            )}
          </div>

          {/* Search narrows the CURRENT drill server-side; it never widens it,
              and it cannot stand in for a filter (see filter_required in
              lib/txnQuery.ts), so it can only ever look inside the slice the
              user already opened. */}
          <div className="dd-search">
            <label className="sr-only" htmlFor="dd-q">Search payee, description or account</label>
            <input
              id="dd-q"
              ref={searchRef}
              className="input"
              type="search"
              inputMode="search"
              maxLength={MAX_Q}
              placeholder="Search payee, description or account…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && draft) { e.stopPropagation(); setDraft(""); }
                if (e.key === "Enter") setQ(draft.trim());
              }}
            />
            {draft && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { setDraft(""); searchRef.current?.focus(); }}
              >
                Clear
              </button>
            )}
          </div>
          {termAltered && (
            <div className="dd-search-hint">
              Searched <span className="mono">{effectiveQ}</span> — characters that are structural in a database
              filter were removed.
            </div>
          )}

          {/* When fact_txn is empty there is nothing to reconcile — the empty
              state below explains it without a red alarm on every click. */}
          {expected && compare && detailTotal !== null && !reconciles && data?.detail_available !== false && (
            <div className="dd-warn" role="alert">
              <b>Does not reconcile.</b> The dashboard figure is {usdExact(expected.amount)} but the transaction
              detail sums to {usdExact(detailTotal)} ({usdExact(diff)} difference). The aggregate tables are the
              reported numbers; <span className="mono">fact_txn</span> is stale or only partly loaded. Do not
              treat this list as complete.
            </div>
          )}
          {compare && detailTotal !== null && reconciles && count > 0 && (
            <div className="dd-ok">Detail sums exactly to the dashboard figure.</div>
          )}
          {expected && !expected.compare && (
            <div className="dd-note">
              {expected.source} comes from the top-150 vendor extract, so it can understate the detail below. The
              detail total is the authoritative figure for this filter.
            </div>
          )}
          {data && data.truncated && (
            <div className="dd-note">
              Showing rows <b>{showing}</b> of <b>{count.toLocaleString()}</b>. This is one page — the row count and
              detail total above cover <b>all</b> {count.toLocaleString()} matching rows, so do not subtotal this
              page.
            </div>
          )}
        </div>

        <div className="dd-body">
          {err && (
            <div className="dd-empty">
              <div className="dd-warn" role="alert" style={{ textAlign: "left" }}>
                <b>Could not load transaction detail{err.status ? ` (HTTP ${err.status})` : ""}.</b>
                <div style={{ marginTop: 4 }}>{err.message}</div>
              </div>
            </div>
          )}
          {!err && busy && !data && <div className="dd-empty">Loading transaction detail…</div>}
          {!err && data && count === 0 && (
            <div className="dd-empty">
              {data.detail_available ? (
                <>No transactions match this filter.</>
              ) : (
                <>
                  <b>No transaction detail loaded yet.</b>
                  <div style={{ marginTop: 6 }}>
                    The dashboard reads pre-aggregated tables; per-transaction rows live in{" "}
                    <span className="mono">fact_txn</span>, which is empty. Upload a CSV to populate it — the
                    aggregates above are unaffected.
                  </div>
                </>
              )}
            </div>
          )}
          {!err && data && count > 0 && (
            <table className="dd-table">
              <thead>
                <tr>
                  <th>
                    <button className="dd-sort" onClick={() => setSortKey("txn_date")} aria-label="Sort by date">
                      Date{sort === "txn_date" ? (dir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                  <th>Type</th>
                  <th>Num</th>
                  <th>Payee</th>
                  <th>Description</th>
                  <th>Account</th>
                  <th className="num">
                    <button className="dd-sort" onClick={() => setSortKey("amount")} aria-label="Sort by amount">
                      Amount{sort === "amount" ? (dir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.row_key}:${r.occurrence}`}>
                    <td className="mono dd-nowrap">{r.txn_date}</td>
                    <td className="t dd-nowrap">{r.txn_type || "—"}</td>
                    <td className="mono dd-nowrap">{r.num || "—"}</td>
                    <td className="t dd-clip" title={r.name || ""}>{r.name || "(no payee)"}</td>
                    <td className="t dd-clip" title={r.description || ""}>{r.description || ""}</td>
                    <td className="t dd-clip" title={r.account_label}>{r.account_label}</td>
                    <td className="num">{usdExact(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="dd-foot">
          <div className="small">
            {count > 0 ? (
              <>
                Rows <b>{showing}</b> of <b>{count.toLocaleString()}</b>
                {busy ? " · loading…" : ""}
              </>
            ) : (
              <>&nbsp;</>
            )}
          </div>
          <div className="dd-pager">
            <label className="small" htmlFor="dd-limit">
              Per page
            </label>
            <select id="dd-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
            <button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0 || busy}>
              ‹ Prev
            </button>
            <button onClick={() => setOffset(offset + limit)} disabled={busy || offset + limit >= count}>
              Next ›
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
