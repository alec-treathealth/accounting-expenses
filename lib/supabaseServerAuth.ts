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

/** The signed-in user for this request, or null. Never throws. */
export async function getSessionUser(): Promise<{ id: string; email: string | null } | null> {
  try {
    const sb = createServerAuthClient();
    // getUser() revalidates the JWT against Supabase — do not use getSession()
    // here, which trusts whatever is in the cookie.
    const { data, error } = await sb.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}
