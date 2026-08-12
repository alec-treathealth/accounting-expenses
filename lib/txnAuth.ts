import { createHash, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Gate for transaction-level reads (/api/txn).
//
// fact_txn is private (RLS on, zero policies) and is read with the service_role
// key, so this route is the ONLY door to per-transaction data. The app has no
// application-level login yet, so this gate is deliberately minimal and
// FAIL-CLOSED. It is NOT a substitute for real authentication — see README
// ("Drill-down authorization") and the PR description. It needs sign-off.
//
// Decision order (first match wins):
//   1. no SUPABASE_SERVICE_ROLE_KEY            -> 503 not_configured
//   2. TXN_DRILLDOWN_ENABLED !== "true"        -> 403 drilldown_disabled
//   3. a token was presented                   -> 401 unless it matches
//                                                 TXN_DRILLDOWN_TOKEN exactly
//   4. otherwise it must look like a first-party browser fetch of this app:
//        - Sec-Fetch-Site: same-origin  (browser-set, page JS cannot forge it)
//        - Origin/Referer host == request host, when either is present
//        - on Vercel: a Deployment-Protection session cookie must be present,
//          unless TXN_ALLOW_UNPROTECTED === "true"
//   5. anything else                           -> 401 unauthenticated
// ---------------------------------------------------------------------------

export type AuthOk = { ok: true; via: "token" | "first-party" };
export type AuthErr = { ok: false; status: number; code: string; message: string };
export type AuthDecision = AuthOk | AuthErr;

// Cookies Vercel sets once a viewer has cleared Deployment Protection (SSO).
const VERCEL_SESSION_COOKIES = ["_vercel_jwt", "_vercel_sso_nonce"];

type HeaderBag = { get(name: string): string | null };

function eqSecret(a: string, b: string): boolean {
  // Hash first so the compare is length-independent and constant-time.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function presentedToken(h: HeaderBag): string | null {
  const direct = h.get("x-drilldown-token");
  if (direct) return direct.trim();
  const auth = h.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return null;
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function hasVercelSession(h: HeaderBag): boolean {
  const cookie = h.get("cookie") || "";
  return VERCEL_SESSION_COOKIES.some((c) => new RegExp(`(?:^|;\\s*)${c}=`).test(cookie));
}

export function authorizeTxnRequest(req: { headers: HeaderBag }): AuthDecision {
  const h = req.headers;

  // 1. Without the service_role key there is no read path at all. Say so
  //    plainly (503, not 401) so a misconfigured deploy is obvious.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: false,
      status: 503,
      code: "not_configured",
      message: "Transaction detail is not configured on this deployment.",
    };
  }

  // 2. Off unless explicitly switched on: a fresh or half-configured
  //    environment serves no transaction detail.
  if (process.env.TXN_DRILLDOWN_ENABLED !== "true") {
    return {
      ok: false,
      status: 403,
      code: "drilldown_disabled",
      message: "Transaction drill-down is disabled on this deployment.",
    };
  }

  // 3. Shared-secret path, for scripted/ops access and for smoke tests.
  const token = presentedToken(h);
  if (token !== null) {
    const expected = process.env.TXN_DRILLDOWN_TOKEN;
    if (!expected || !eqSecret(token, expected)) {
      return { ok: false, status: 401, code: "invalid_token", message: "Invalid drill-down token." };
    }
    return { ok: true, via: "token" };
  }

  // 4. First-party browser path.
  const site = (h.get("sec-fetch-site") || "").toLowerCase();
  if (!site) {
    return {
      ok: false,
      status: 401,
      code: "unauthenticated",
      message: "Transaction detail requires a first-party request or a drill-down token.",
    };
  }
  if (site !== "same-origin") {
    return {
      ok: false,
      status: 403,
      code: "cross_site",
      message: "Transaction detail may only be read by the dashboard itself.",
    };
  }

  const host = (h.get("host") || "").toLowerCase();
  const claimed = hostOf(h.get("origin")) || hostOf(h.get("referer"));
  if (host && claimed && claimed !== host) {
    return { ok: false, status: 403, code: "cross_site", message: "Origin does not match this host." };
  }

  if (process.env.VERCEL === "1" && process.env.TXN_ALLOW_UNPROTECTED !== "true" && !hasVercelSession(h)) {
    return {
      ok: false,
      status: 401,
      code: "no_platform_session",
      message: "No Vercel Deployment Protection session on this request.",
    };
  }

  return { ok: true, via: "first-party" };
}
