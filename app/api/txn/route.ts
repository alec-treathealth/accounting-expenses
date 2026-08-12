import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { authorizeTxnRequest } from "@/lib/txnAuth";
import { getAuthorizedUser } from "@/lib/supabaseServerAuth";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_OFFSET,
  fetchTxnPage,
  loadAllowlists,
  parseTxnParams,
  type TxnDb,
} from "@/lib/txnQuery";

// Server-only. fact_txn has RLS on with ZERO policies, so it is unreadable with
// the publishable key; this route reads it with the service_role client and is
// therefore the single door to transaction-level data. Node runtime (not edge)
// because the service_role key must never reach the client bundle.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Verified necessary: with only force-dynamic, Next still served the outbound
// PostgREST GETs from its fetch cache, so a drill-down could show rows that had
// since been re-ingested. Financial detail must never be cached.
export const fetchCache = "force-no-store";
export const revalidate = 0;

const NO_STORE = { "cache-control": "no-store" } as const;

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: code, message }, { status, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const auth = await authorizeTxnRequest(req, async () => (await getAuthorizedUser()) !== null);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);

  let db: TxnDb;
  try {
    // supabaseAdmin() returns a full SupabaseClient; TxnDb is the narrow
    // read-only slice of it this module uses (see lib/txnQuery.ts), which lets
    // the same query code run against an in-memory fixture in tests.
    db = supabaseAdmin() as unknown as TxnDb;
  } catch {
    return fail(503, "not_configured", "Transaction detail is not configured on this deployment.");
  }

  try {
    const allow = await loadAllowlists(db);
    const parsed = parseTxnParams(req.nextUrl.searchParams, allow);
    if (!parsed.ok) return fail(400, parsed.code, parsed.message);

    const f = parsed.filters;
    const page = await fetchTxnPage(db, f);

    return NextResponse.json(
      {
        filters: {
          facility: f.facility,
          month: f.month,
          posted_period: f.month ? `${f.month}-01` : null,
          kpi_group: f.kpi_group,
          account_label: f.account_label,
          vendor: f.vendor,
          /* Echo the SANITIZED term, not what was typed: the client shows this
             so a user whose punctuation was stripped can see what actually ran.
             `searched` tells the drawer that `totals` describes a SUBSET, so it
             must compare against the search, not against the dashboard figure —
             otherwise every search would look like a reconciliation failure. */
          q: f.q,
          searched: f.q !== null,
          sort: f.sort,
          dir: f.dir,
        },
        ...page,
        limits: { default_limit: DEFAULT_LIMIT, max_limit: MAX_LIMIT, max_offset: MAX_OFFSET },
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    // Never surface the underlying client/key details to the caller.
    console.error("[api/txn] read failed:", e instanceof Error ? e.message : "unknown error");
    return fail(500, "read_failed", "Could not read transaction detail.");
  }
}
