import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Paths reachable without a session. Everything else requires one.
// /api/* is excluded from the redirect because API routes must answer with
// JSON 401s, not an HTML redirect — each route guards itself.
const PUBLIC_PATHS = ["/login", "/auth"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Must run: this is what refreshes an expiring token and rewrites the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A session is not access. Public signup is open on this project, so anyone
  // can obtain a valid session; public.app_access is the actual invite list.
  // Checking it here means an uninvited account is bounced to /login rather
  // than landing on a dashboard that RLS has silently emptied.
  let invited = false;
  if (user) {
    const { data, error } = await supabase.rpc("has_dashboard_access");
    invited = !error && data === true;
  }

  const { pathname } = request.nextUrl;
  if (!invited && !isPublic(pathname) && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve where they were headed so login can send them back.
    url.searchParams.set("next", pathname);
    if (user) url.searchParams.set("denied", "1");
    return NextResponse.redirect(url);
  }

  return response;
}
