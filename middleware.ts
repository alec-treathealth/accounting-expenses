import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabaseMiddleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Everything except Next internals and static assets. Auth cookies must be
  // refreshed on API routes too, so /api is intentionally NOT excluded here —
  // updateSession() simply does not redirect for it.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
