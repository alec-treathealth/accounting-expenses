"use client";

import { useCallback, useRef, useState } from "react";
import { ingestCsv, type IngestResult } from "@/lib/parse";
import { usd } from "@/lib/format";

// Drag-and-drop CSV ingest. The whole parse + classify + aggregate runs in the
// browser; only the (small) fact rows are POSTed to /api/ingest, in chunks to
// stay under Vercel's request-body limit. The server appends new rows only
// (idempotent) and rebuilds the aggregates. We show the reconciled total and
// require a confirm before anything is written.
export default function Upload({ onDone }: { onDone: () => void }) {
  const [over, setOver] = useState(false);
  const [parsed, setParsed] = useState<IngestResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    setResult(null); setMsg(""); setParsed(null); setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setParsed(ingestCsv(String(reader.result || "")));
      } catch (e: any) {
        setMsg("Could not parse this file: " + (e?.message || e));
      }
    };
    reader.readAsText(file);
  }, []);

  const commit = async () => {
    if (!parsed) return;
    setBusy(true); setProgress(0); setMsg("Uploading transactions…");
    try {
      const rows = parsed.factRows;
      const CHUNK = 4000;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const r = await fetch("/api/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phase: "rows", rows: chunk }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "upload failed");
        inserted += j.inserted || 0;
        setProgress(Math.round(((i + chunk.length) / rows.length) * 100));
      }
      setMsg("Rebuilding aggregates…");
      const keys = parsed.factRows.map((f) => `${f.row_key}:${f.occurrence}`);
      const fr = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "finalize", months: parsed.monthsPresent, keys }),
      });
      const fj = await fr.json();
      if (!fr.ok) throw new Error(fj.error || "finalize failed");
      setResult({ inserted, ...fj });
      setMsg("");
      onDone();
    } catch (e: any) {
      setMsg("Error: " + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Update data — drop a QuickBooks export</h2>

      {!parsed && !result && (
        <div
          className={"drop" + (over ? " over" : "")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          onClick={() => inputRef.current?.click()}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Drop the “Consolidated transaction detail” CSV here</div>
          <div className="small">or click to choose a file · parsed in your browser, nothing uploads until you confirm</div>
          <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        </div>
      )}

      {parsed && !result && (
        <div>
          <div className="small" style={{ marginBottom: 8 }}>
            <b>{fileName}</b> parsed — <b>{usd(parsed.total)}</b> across {parsed.facilitiesPresent.length} facilities,{" "}
            {parsed.factRows.length.toLocaleString()} in-scope rows, months {parsed.monthsPresent.join(", ")}.
          </div>
          <div className="small" style={{ marginBottom: 10, color: "var(--muted)" }}>
            Confirm to append only new transactions (existing rows are skipped) and rebuild the dashboard. Nothing is deleted.
          </div>
          {busy && <div className="progress"><div style={{ width: progress + "%" }} /></div>}
          {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn-primary" onClick={commit} disabled={busy}>{busy ? "Working…" : "Confirm & update"}</button>
            <button onClick={() => { setParsed(null); setFileName(""); }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div className="small">
          <div style={{ fontWeight: 600, color: "var(--good)", marginBottom: 6 }}>Done.</div>
          <div>{result.inserted.toLocaleString()} new transaction{result.inserted === 1 ? "" : "s"} appended.</div>
          <div>Dashboard total now <b>{usd(result.total)}</b>.</div>
          {result.orphans_count > 0 && (
            <div style={{ marginTop: 8, color: "var(--bad)" }}>
              {result.orphans_count} existing row{result.orphans_count === 1 ? "" : "s"} in the uploaded months weren’t in this file —
              likely edited or removed upstream. Left in place for review (not deleted).
            </div>
          )}
          <button style={{ marginTop: 12 }} onClick={() => { setParsed(null); setResult(null); setFileName(""); }}>Upload another</button>
        </div>
      )}
    </section>
  );
}
