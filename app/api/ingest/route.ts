import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

// Node runtime (not edge) so we can use the service_role key and a longer budget.
export const runtime = "nodejs";
export const maxDuration = 60;

type FactRow = {
  row_key: string; occurrence: number; facility: string; txn_date: string;
  posted_period: string; txn_type: string; num: string; name: string;
  description: string; split: string; account_num: string | null;
  account_label: string; kpi_group: string; kind: string; amount: number;
};

export async function POST(req: NextRequest) {
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

    const months: string[] = body.months || [];
    const uploadedKeys: string[] = body.keys || []; // "row_key:occurrence"
    let orphans: any[] = [];
    if (months.length && uploadedKeys.length) {
      const periods = months.map((m) => `${m}-01`);
      const { data } = await sb
        .from("fact_txn")
        .select("row_key,occurrence,facility,posted_period,account_label,amount")
        .in("posted_period", periods);
      const set = new Set(uploadedKeys);
      orphans = (data || [])
        .filter((r: any) => !set.has(`${r.row_key}:${r.occurrence}`))
        .slice(0, 500);
    }

    const { data: tot } = await sb.from("agg_group_month").select("amount");
    const total = (tot || []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    return NextResponse.json({
      ok: true,
      total: Math.round(total * 100) / 100,
      orphans_count: orphans.length,
      orphans,
    });
  }

  return NextResponse.json({ error: "unknown phase" }, { status: 400 });
}
