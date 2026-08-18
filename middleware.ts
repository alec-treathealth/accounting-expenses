import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabaseMiddleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Everything except Next internals, static assets, and /api.
  //
  // /api is excluded deliberately. Every API route calls getAuthorizedUser()
  // itself — that check is the security boundary, not this one, because
  // /api/txn reads fact_txn with service_role and so bypasses RLS entirely.
  // Running middleware there too meant each drill-down paid FOUR sequential
  // round trips to Supabase (getUser + has_dashboard_access, twice) before any
  // data was read. Routes still refuse anonymous callers; only the duplication
  // is gone.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
