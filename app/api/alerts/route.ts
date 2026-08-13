import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { authorizeTxnRequest } from "@/lib/txnAuth";
import { getAuthorizedUser } from "@/lib/supabaseServerAuth";
import { parseAlert, type Alert } from "@/lib/alerts";

// Out-of-the-norm Ramp charges.
//
// The rules live in public.ramp_alerts() (supabase/migrations/0009). That
// function returns TRANSACTION-GRAIN rows — a date, a merchant, an amount and a
// named person — which is the same class of data as fact_txn. fact_txn has had
// RLS on with zero policies since 0001 and is reachable only with the
// service_role key, so this route sits behind the SAME gate as /api/txn rather
// than the aggregates being browser-readable. Sharing authorizeTxnRequest is the
// point: one door, one policy, no second implementation to drift.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const NO_STORE = { "cache-control": "no-store" } as const;

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: code, message }, { status, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const auth = await authorizeTxnRequest(req, async () => (await getAuthorizedUser()) !== null);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);

  let db;
  try {
    db = supabaseAdmin();
  } catch {
    return fail(503, "not_configured", "Expense alerts are not configured on this deployment.");
  }

  try {
    const { data, error } = await db.rpc("ramp_alerts");
    if (error) throw new Error(error.message);

    /* Validate rather than cast. The rows come back over the wire, and a shape
       that does not match should be DROPPED, not rendered as "$undefined" inside
       a currency string on a financial screen. `dropped` is reported so a silent
       schema drift shows up as a number instead of as a shorter list. */
    const raw = Array.isArray(data) ? data : [];
    const alerts: Alert[] = [];
    for (const row of raw) {
      const a = parseAlert(row);
      if (a) alerts.push(a);
    }
    const dropped = raw.length - alerts.length;
    if (dropped > 0) console.warn(`[api/alerts] dropped ${dropped} malformed alert row(s)`);

    return NextResponse.json({ alerts, dropped }, { headers: NO_STORE });
  } catch (e) {
    // Never surface the underlying client/key details to the caller.
    console.error("[api/alerts] read failed:", e instanceof Error ? e.message : "unknown error");
    return fail(500, "read_failed", "Could not compute expense alerts.");
  }
}
