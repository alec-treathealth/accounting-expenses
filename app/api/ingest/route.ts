import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { getAuthorizedUser } from "@/lib/supabaseServerAuth";

// Node runtime (not edge) so we can use the service_role key and a longer budget.
export const runtime = "nodejs";
export const maxDuration = 60;

type FactRow = {
  row_key: string; occurrence: number; facility: string; txn_date: string;
  posted_period: string; txn_type: string; num: string; name: string;
  description: string; split: string; account_num: string | null;
  account_label: string; kpi_group: string; kind: string; amount: number;
};

/**
 * Read every row a query matches, in pages.
 *
 * `.select()` without a range returns at most db-max-rows (1000 on this
 * project) and says nothing about it — no error, no truncation flag. Any
 * server-side scan of fact_txn that does not page is reading 1/34th of the
 * table and reporting the answer as if it were complete.
 *
 * Steps by what came back and stops on an empty page: "fewer than I asked for"
 * is not a reliable end-of-data signal, it is the very thing db-max-rows does.
 * The caller must impose a total order, or pages can repeat or skip rows.
 */
async function* pageRows(
  q: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>,
): AsyncGenerator<any> {
  const PAGE = 1000;
  const HARD_CAP = 500_000; // runaway guard; ~15x the current fact_txn
  for (let from = 0; from < HARD_CAP; ) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    if (!rows.length) return;
    for (const r of rows) yield r;
    from += rows.length;
  }
}

export async function POST(req: NextRequest) {
  // This route writes fact_txn and rebuilds every aggregate the dashboard
  // shows, and until now had NO authentication of its own — it relied entirely
  // on Vercel Deployment Protection, which is no longer in front of it.
  if (!(await getAuthorizedUser())) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to upload transaction data." },
      { status: 401 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const sb = supabaseAdmin();

  // Phase 1: append a chunk of fact rows. ON CONFLICT DO NOTHING makes this
  // idempotent and "append-new-only" — re-sending existing rows inserts zero.
  if (body.phase === "rows") {
    const rows = (body.rows as FactRow[]) || [];
    if (!rows.length) return NextResponse.json({ inserted: 0 });
    const { error, count } = await sb
      .from("fact_txn")
      .upsert(rows, { onConflict: "row_key,occurrence", ignoreDuplicates: true, count: "exact" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ inserted: count ?? 0 });
  }

  // Phase 2: rebuild aggregates and report what looks changed/removed upstream.
  if (body.phase === "finalize") {
    const { error: rbErr } = await sb.rpc("rebuild_aggregates");
    if (rbErr) return NextResponse.json({ error: rbErr.message }, { status: 500 });

    /* Stamp the refresh AFTER the rebuild succeeds — the top bar's freshness
       tag reads the newest row, and it must say "when the figures changed",
       never "when someone tried". Non-fatal on failure: a missing stamp is a
       stale tag, not a broken upload, and the rebuild is already committed. */
    const { error: logErr } = await sb.from("ingest_log").insert({ source: "csv-upload" });
    if (logErr) console.error("[ingest] could not stamp ingest_log:", logErr.message);

    const months: string[] = body.months || [];
    const uploadedKeys: string[] = body.keys || []; // "row_key:occurrence"
    let orphans: any[] = [];
    let orphansTotal = 0;
    if (months.length && uploadedKeys.length) {
      const periods = months.map((m) => `${m}-01`);
      const set = new Set(uploadedKeys);
      /* PAGED. PostgREST caps a response at db-max-rows (1000 here) even for the
         service role, silently. Unpaged, this scanned 1,000 of 34,000+ rows and
         under-reported "rows in these months that are in the warehouse but not
         in your file" by ~97% — a safety net that quietly reported almost
         nothing. The COUNT is taken before the 500-row display cut, so the
         number shown is the true one even though the list is trimmed. */
      for await (const r of pageRows(
        (from, to) =>
          sb
            .from("fact_txn")
            .select("row_key,occurrence,facility,posted_period,account_label,amount")
            .in("posted_period", periods)
            .order("row_key", { ascending: true })
            .order("occurrence", { ascending: true })
            .range(from, to),
      )) {
        if (set.has(`${r.row_key}:${r.occurrence}`)) continue;
        orphansTotal++;
        if (orphans.length < 500) orphans.push(r);
      }
    }

    let total = 0;
    for await (const r of pageRows((from, to) =>
      sb.from("agg_group_month").select("amount").order("amount", { ascending: true }).range(from, to),
    )) {
      total += Number(r.amount);
    }
    return NextResponse.json({
      ok: true,
      total: Math.round(total * 100) / 100,
      orphans_count: orphansTotal,
      orphans,
      orphans_truncated: orphansTotal > orphans.length,
    });
  }

  return NextResponse.json({ error: "unknown phase" }, { status: 400 });
}
