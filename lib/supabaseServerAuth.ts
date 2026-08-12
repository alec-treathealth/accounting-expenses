import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Request-scoped client used ONLY to answer "who is this request?".
//
// Deliberately separate from lib/supabaseServer.ts (the service_role admin
// client): this one carries the caller's own JWT and is subject to RLS, so a
// bug here can never escalate to service_role. Data reads still go through the
// admin client in the route, AFTER this has established there is a session.
export function createServerAuthClient(): SupabaseClient {
  const store = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    {
      cookies: {
        getAll() {
          return store.getAll();
        },
        setAll(cookiesToSet) {
          // Route handlers may refresh the session; in a Server Component this
          // throws, which is expected and safe to swallow because middleware
          // has already refreshed the cookie for this request.
          try {
            for (const { name, value, options } of cookiesToSet) {
              store.set(name, value, options);
            }
          } catch {
            /* called from a Server Component — middleware owns the refresh */
          }
        },
      },
    },
  );
}

/**
 * The signed-in AND invited user for this request, or null. Never throws.
 *
 * Both halves are load-bearing. Public signup is open on this project, so a
 * valid session proves only that someone registered an email address — it says
 * nothing about whether they are allowed to see company financials. Membership
 * of public.app_access is the actual grant.
 *
 * This matters most for /api/txn, which reads fact_txn with the service_role
 * key. service_role BYPASSES RLS, so the database policies cannot protect that
 * route; this check is the only thing standing in front of transaction detail.
 */
export async function getAuthorizedUser(): Promise<{ id: string; email: string | null } | null> {
  try {
    const sb = createServerAuthClient();
    // getUser() revalidates the JWT against Supabase — do not use getSession()
    // here, which trusts whatever is in the cookie.
    const { data, error } = await sb.auth.getUser();
    if (error || !data.user) return null;

    // SECURITY DEFINER function, so app_access itself stays unreadable.
    const { data: allowed, error: rpcErr } = await sb.rpc("has_dashboard_access");
    if (rpcErr || allowed !== true) return null;

    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}
