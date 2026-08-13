"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ingestCsv, type IngestResult } from "@/lib/parse";
import { usd } from "@/lib/format";
import { useWarehouse } from "@/components/WarehouseProvider";
import Icon from "@/components/Icon";

/* Update the warehouse from a fresh QuickBooks export.
 *
 * The CSV is parsed, classified and reconciled ENTIRELY IN THE BROWSER; only the
 * in-scope fact rows are POSTed, in chunks, to stay under Vercel's request-body
 * limit. The server appends new rows only — it never deletes — and then rebuilds
 * the aggregates, whose own guards refuse to write a set that does not tie back
 * to fact_txn.
 *
 * The confirm step is kept deliberately. Everything after it is automatic, but
 * uploading the wrong file into a financial warehouse is not an error you notice
 * later, and the summary it shows (total, facilities, months, row count) is
 * exactly what tells you at a glance whether this is the file you meant.
 */

/* The "Consolidated transaction detail" report this dashboard is built from.
   Held here rather than typed by the user each month: the report id is opaque,
   and one wrong character lands them on a different report whose columns look
   similar enough to upload by mistake. */
const QBO_REPORT_URL =
  "https://qbo.intuit.com/app/report/builder?rptId=sbg:d4061d26-8b73-4e71-a063-f6f49849ca14&type=system&previousRoute=standardreports&previousRouteText=Back%20to%20standard%20reports";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Phase = "idle" | "parsing" | "ready" | "uploading" | "rebuilding" | "done";

export default function UpdateDataDialog({ onClose }: { onClose: () => void }) {
  const { reload } = useWarehouse();

  const [phase, setPhase] = useState<Phase>("idle");
  const [over, setOver] = useState(false);
  const [parsed, setParsed] = useState<IngestResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ inserted: number; total: number; orphans_count?: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const busy = phase === "uploading" || phase === "rebuilding";

  // Focus into the dialog, lock background scroll, hand focus back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, []);

  // Escape closes — but never mid-write, which would leave the user unsure
  // whether the upload finished.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
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
  }, []);

  const handleFile = useCallback((file: File) => {
    setError("");
    setResult(null);
    setParsed(null);
    setFileName(file.name);
    setPhase("parsing");
    const reader = new FileReader();
    reader.onerror = () => {
      setError("That file could not be read.");
      setPhase("idle");
    };
    reader.onload = () => {
      try {
        const out = ingestCsv(String(reader.result || ""));
        if (!out.factRows.length) {
          setError("No in-scope expense rows found. Is this the “Consolidated transaction detail” report?");
          setPhase("idle");
          return;
        }
        setParsed(out);
        setPhase("ready");
      } catch (e: any) {
        setError("Could not parse this file: " + (e?.message || e));
        setPhase("idle");
      }
    };
    reader.readAsText(file);
  }, []);

  const commit = async () => {
    if (!parsed) return;
    setPhase("uploading");
    setProgress(0);
    setError("");
    try {
      const rows = parsed.factRows;
      const CHUNK = 4000;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const r = await fetch("/api/ingest", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phase: "rows", rows: chunk }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || j.error || "upload failed");
        inserted += j.inserted || 0;
        // Sending rows is 90% of the bar; the rebuild is the last 10%. A bar
        // that hits 100% and then sits there is worse than one that is honest
        // about having a second phase.
        setProgress(Math.round(((i + chunk.length) / rows.length) * 90));
      }

      setPhase("rebuilding");
      setProgress(92);
      const keys = parsed.factRows.map((f) => `${f.row_key}:${f.occurrence}`);
      const fr = await fetch("/api/ingest", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "finalize", months: parsed.monthsPresent, keys }),
      });
      const fj = await fr.json();
      if (!fr.ok) throw new Error(fj.message || fj.error || "rebuild failed");

      setProgress(100);
      setResult({ inserted, ...fj });
      setPhase("done");
      // Every route reads the same cached datasets, so refreshing the shared
      // cache is what "the dashboard updates itself" actually means.
      reload();
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase("ready");
    }
  };

  const reset = () => {
    setParsed(null);
    setResult(null);
    setFileName("");
    setProgress(0);
    setError("");
    setPhase("idle");
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="dialog update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="update-head">
          <div>
            <h2 id="update-title" className="dialog-title">Update data</h2>
            <p className="fine" style={{ marginTop: 2 }}>
              Append a fresh “Consolidated transaction detail” export. Existing transactions are skipped and
              nothing is ever deleted.
            </p>
          </div>
          <button
            ref={closeRef}
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>

        {/* Step 1 — get the file. The report link is behind a button rather than
            printed as a URL: it is 180 opaque characters and nobody should be
            asked to check it. */}
        <section className="update-step">
          <h3>1 · Get the report</h3>
          <a
            className="btn btn-secondary"
            href={QBO_REPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Fetch Report From QuickBooks
            <span aria-hidden="true"> ↗</span>
          </a>
          <p className="fine">
            Opens the report in QuickBooks in a new tab. Set the date range you want, then <b>Export → CSV</b> and
            come back here. <span className="sr-only">Link opens in a new tab.</span>
          </p>
        </section>

        {/* Step 2 — the file itself. */}
        <section className="update-step">
          <h3>2 · Upload the CSV</h3>

          {phase === "idle" || phase === "parsing" ? (
            <div
              className={"drop" + (over ? " over" : "")}
              role="button"
              tabIndex={0}
              aria-label="Drop the CSV here, or browse for a file"
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
            >
              <Icon name="upload" size={26} />
              <div style={{ fontWeight: 600, margin: "6px 0 2px" }}>
                {phase === "parsing" ? `Reading ${fileName}…` : "Drag and drop the CSV here"}
              </div>
              <div className="small">
                or <span className="drop-browse">browse your folders</span> · parsed in your browser, nothing is
                sent until you confirm
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  // Reset so choosing the SAME file again still fires onChange.
                  e.target.value = "";
                }}
              />
            </div>
          ) : null}

          {parsed && phase !== "done" && (
            <div className="update-summary">
              <div>
                <b>{fileName}</b>
              </div>
              <dl className="stat-pair">
                <div>
                  <dt>Reconciled total</dt>
                  <dd>{usd(parsed.total)}</dd>
                </div>
                <div>
                  <dt>In-scope rows</dt>
                  <dd>{parsed.factRows.length.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Facilities</dt>
                  <dd>{parsed.facilitiesPresent.length}</dd>
                </div>
              </dl>
              <p className="fine">Months in this file: {parsed.monthsPresent.join(", ")}.</p>

              {busy && (
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={phase === "uploading" ? "Uploading transactions" : "Rebuilding the dashboard"}
                >
                  <div style={{ width: progress + "%" }} />
                </div>
              )}
              <p className="fine" aria-live="polite">
                {phase === "uploading"
                  ? `Uploading transactions… ${progress}%`
                  : phase === "rebuilding"
                    ? "Rebuilding the dashboard…"
                    : "Confirm to append only new transactions and rebuild the dashboard."}
              </p>

              <div className="update-actions">
                <button className="btn btn-update" onClick={commit} disabled={busy}>
                  {busy ? "Working…" : "Confirm & update"}
                </button>
                <button className="btn btn-secondary" onClick={reset} disabled={busy}>
                  Choose a different file
                </button>
              </div>
            </div>
          )}

          {phase === "done" && result && (
            <div className="update-summary">
              <p style={{ color: "var(--color-ok)", fontWeight: 600, margin: 0 }}>Done — the dashboard is updated.</p>
              <dl className="stat-pair">
                <div>
                  <dt>New transactions</dt>
                  <dd>{result.inserted.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Dashboard total</dt>
                  <dd>{usd(result.total)}</dd>
                </div>
              </dl>
              {!!result.orphans_count && result.orphans_count > 0 && (
                <div className="dd-warn" role="alert">
                  {result.orphans_count} existing row{result.orphans_count === 1 ? "" : "s"} in the uploaded months
                  were not in this file — likely edited or removed upstream. They were left in place for review, not
                  deleted.
                </div>
              )}
              <div className="update-actions">
                <button className="btn btn-update" onClick={onClose}>
                  Close
                </button>
                <button className="btn btn-secondary" onClick={reset}>
                  Upload another
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="dd-warn" role="alert">
              {error}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
