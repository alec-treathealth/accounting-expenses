# Supabase Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put per-user email+password sign-in in front of the expense dashboard, and move the aggregate tables from `anon` to `authenticated` so the publishable key stops being a data key.

**Architecture:** Supabase Auth (email+password, invite-only, no roles). Sessions live in cookies via `@supabase/ssr` so both browser and route handlers can read them. Middleware refreshes the session and guards pages. `authorizeTxnRequest` keeps its synchronous, unit-tested gates 1–3 and swaps the Vercel-cookie gate for an injected session probe.

**Tech Stack:** Next.js 14.2.35 (App Router), `@supabase/ssr` ^0.12.4, `@supabase/supabase-js` 2.112.3, TypeScript, Supabase Postgres.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-08-12-supabase-auth-design.md`
- Node/Next: Next 14.2.35, App Router, `runtime = "nodejs"` on existing API routes — do not change.
- **No test framework exists.** Tests are `.mts` verification scripts run via `tsx`, using the `ok(cond, label, detail)` helper and `process.exit(failures === 0 ? 0 : 1)`. Follow that idiom exactly. Do NOT add vitest/jest.
- `lib/supabaseServer.ts` (service-role admin client) must never be imported into a client component and is NOT modified by this plan.
- The service-role key must never reach the client bundle. Only `NEXT_PUBLIC_*` vars may appear in client code.
- Existing env var names are fixed: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TXN_DRILLDOWN_ENABLED`, `TXN_DRILLDOWN_TOKEN`, `ADMIN_API_TOKEN`.
- Do NOT apply the RLS migration (Task 6) until sign-in is verified working. Reversing this order locks the operator out with no UI recovery path.
- Branch: `feat/treat-design-system`. Commit after each task.

---

### Task 1: Cookie-based Supabase clients

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `lib/supabaseBrowser.ts`
- Create: `lib/supabaseServerAuth.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `getSupabaseBrowser(): SupabaseClient` — unchanged name/signature, now cookie-backed
  - `createServerAuthClient(): SupabaseClient` — reads request cookies, for route handlers
  - `getSessionUser(): Promise<{ id: string; email: string | null } | null>` — resolves the signed-in user, or null

- [ ] **Step 1: Install the dependency**

```bash
cd /Users/aleclowi/accounting/aed
npm install @supabase/ssr@^0.12.4
```

- [ ] **Step 2: Replace the browser client with a cookie-backed one**

Replace the entire contents of `lib/supabaseBrowser.ts`:

```ts
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Lazily created so the client is only constructed in the browser at runtime
// (where NEXT_PUBLIC_* are inlined) — not at module import during the build
// prerender, which would throw if the env vars aren't set yet.
//
// createBrowserClient (not createClient) so the session is stored in COOKIES
// rather than localStorage. The API routes and middleware read the same cookies,
// which is what lets /api/txn know who is asking.
let client: SupabaseClient | null = null;

export function getSupabaseBrowser(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;
  client = createBrowserClient(url, key);
  return client;
}
```

- [ ] **Step 3: Create the server-side session client**

Create `lib/supabaseServerAuth.ts`:

```ts
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
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (Pre-existing unrelated errors, if any, must not increase.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/supabaseBrowser.ts lib/supabaseServerAuth.ts
git commit -m "Add cookie-backed Supabase clients for browser and server"
```

---

### Task 2: Middleware guard and the login page

**Files:**
- Create: `lib/supabaseMiddleware.ts`
- Create: `middleware.ts`
- Create: `app/login/page.tsx`

**Interfaces:**
- Consumes: `@supabase/ssr`
- Produces: `updateSession(request: NextRequest): Promise<NextResponse>` — refreshes the auth cookie and redirects unauthenticated page requests to `/login`

- [ ] **Step 1: Create the middleware helper**

Create `lib/supabaseMiddleware.ts`:

```ts
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

  const { pathname } = request.nextUrl;
  if (!user && !isPublic(pathname) && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve where they were headed so login can send them back.
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}
```

- [ ] **Step 2: Create the middleware entry point**

Create `middleware.ts` at the repo root (next to `next.config.mjs`):

```ts
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
```

- [ ] **Step 3: Create the login page**

Create `app/login/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await getSupabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) {
      // Deliberately does not distinguish "unknown email" from "wrong password":
      // that difference tells an attacker which addresses have accounts.
      setError("That email and password combination was not recognised.");
      setBusy(false);
      return;
    }
    const next = params.get("next") || "/";
    router.replace(next);
    router.refresh();
  }

  return (
    <main className="wrap" style={{ maxWidth: 380, marginTop: "12vh" }}>
      <h1 style={{ marginBottom: 4 }}>Treat Health</h1>
      <p style={{ opacity: 0.7, marginTop: 0, marginBottom: 20 }}>Expense Dashboard</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", marginBottom: 12 }}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", marginBottom: 16 }}
        />
        {error && (
          <p role="alert" style={{ color: "var(--color-danger, #d66)", marginTop: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Verify the redirect works**

Run: `npx next dev -p 3111` then in another shell:

```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" "http://localhost:3111/"
```

Expected: `307 http://localhost:3111/login?next=%2F` (unauthenticated page request redirects).

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "http://localhost:3111/login"
```

Expected: `200` (login page itself is reachable).

- [ ] **Step 6: Commit**

```bash
git add lib/supabaseMiddleware.ts middleware.ts app/login/page.tsx
git commit -m "Add session middleware and email+password login page"
```

---

### Task 3: Replace the Vercel gate in /api/txn with a session check

**Files:**
- Modify: `lib/txnAuth.ts`
- Modify: `app/api/txn/route.ts`
- Modify: `verify/txn-drilldown.mts`

**Interfaces:**
- Consumes: `getSessionUser()` from Task 1
- Produces: `authorizeTxnRequest(req, hasSession): Promise<AuthDecision>` — now async, takes an injected probe

**Why dependency injection:** `authorizeTxnRequest` is covered by nine assertions in `verify/txn-drilldown.mts` that run with no network. Injecting the session probe keeps those tests offline and synchronous in spirit, instead of forcing the verifier to stand up a real Supabase session.

- [ ] **Step 1: Update the failing test first**

In `verify/txn-drilldown.mts`, replace the auth-gate block (the section starting `console.log("\n== auth gate (lib/txnAuth) ==")` through the final `ok(...)` of that block) with:

```ts
console.log("\n== auth gate (lib/txnAuth) ==");
const hdrs = (h: Record<string, string>) => ({ headers: { get: (k: string) => h[k.toLowerCase()] ?? null } });
const decide = async (
  env: Record<string, string | undefined>,
  h: Record<string, string>,
  session = false,
) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const d = await authorizeTxnRequest(hdrs(h), async () => session);
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return d;
};
const ON = { SUPABASE_SERVICE_ROLE_KEY: "test-key", TXN_DRILLDOWN_ENABLED: "true", TXN_DRILLDOWN_TOKEN: "test-token-not-a-real-secret" };
type Decision = Awaited<ReturnType<typeof authorizeTxnRequest>>;
const st = (d: Decision) => (d.ok ? 200 : d.status);
const cd = (d: Decision) => (d.ok ? "ok:" + d.via : d.code);

{
  let d = await decide({ ...ON, SUPABASE_SERVICE_ROLE_KEY: undefined }, {});
  ok(st(d) === 503, "no service_role key -> 503", cd(d));

  d = await decide({ ...ON, TXN_DRILLDOWN_ENABLED: undefined }, { "sec-fetch-site": "same-origin" });
  ok(st(d) === 403, "drill-down off by default -> 403", cd(d));

  d = await decide(ON, {});
  ok(st(d) === 401, "bare request, no headers -> 401", cd(d));

  d = await decide(ON, { "sec-fetch-site": "cross-site", origin: "https://evil.example" });
  ok(st(d) === 403, "cross-site fetch -> 403", cd(d));

  d = await decide(ON, { "sec-fetch-site": "same-origin", host: "app.example", origin: "https://evil.example" });
  ok(st(d) === 403, "same-origin claim with foreign Origin -> 403", cd(d));

  d = await decide(ON, { authorization: "Bearer wrong" });
  ok(st(d) === 401, "wrong bearer token -> 401", cd(d));

  d = await decide({ ...ON, TXN_DRILLDOWN_TOKEN: undefined }, { "x-drilldown-token": "anything" });
  ok(st(d) === 401, "token presented but none configured -> 401", cd(d));

  d = await decide(ON, { "x-drilldown-token": "test-token-not-a-real-secret" });
  ok(st(d) === 200, "correct token -> allowed", cd(d));

  // The Supabase session replaces the old Vercel Deployment Protection cookie.
  d = await decide(ON, { "sec-fetch-site": "same-origin", host: "app.example", origin: "https://app.example" }, false);
  ok(st(d) === 401 && cd(d) === "no_session", "first-party fetch with no session -> 401", cd(d));

  d = await decide(ON, { "sec-fetch-site": "same-origin", host: "app.example", origin: "https://app.example" }, true);
  ok(st(d) === 200, "first-party fetch with a session -> allowed", cd(d));
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run verify:drilldown`
Expected: FAIL — TypeScript/runtime error because `authorizeTxnRequest` does not yet accept a second argument or return a Promise.

- [ ] **Step 3: Implement the change in `lib/txnAuth.ts`**

Replace the `VERCEL_SESSION_COOKIES` constant and the `hasVercelSession` function (delete both), and change the export. Specifically:

Delete:
```ts
const VERCEL_SESSION_COOKIES = ["_vercel_jwt", "_vercel_sso_nonce"];
```
and
```ts
function hasVercelSession(h: HeaderBag): boolean {
  const cookie = h.get("cookie") || "";
  return VERCEL_SESSION_COOKIES.some((c) => new RegExp(`(?:^|;\\s*)${c}=`).test(cookie));
}
```

Add above `authorizeTxnRequest`:
```ts
/** Resolves whether this request carries a valid signed-in session. Injected so
 *  the gate stays unit-testable with no network. */
export type SessionProbe = () => Promise<boolean>;
```

Change the signature from:
```ts
export function authorizeTxnRequest(req: { headers: HeaderBag }): AuthDecision {
```
to:
```ts
export async function authorizeTxnRequest(
  req: { headers: HeaderBag },
  hasSession: SessionProbe,
): Promise<AuthDecision> {
```

Replace this block:
```ts
  if (process.env.VERCEL === "1" && process.env.TXN_ALLOW_UNPROTECTED !== "true" && !hasVercelSession(h)) {
    return {
      ok: false,
      status: 401,
      code: "no_platform_session",
      message: "No Vercel Deployment Protection session on this request.",
    };
  }

  return { ok: true, via: "first-party" };
```

with:
```ts
  // Gate 4: a real application session. This replaced the Vercel Deployment
  // Protection cookie check — that gated on Vercel team membership, which could
  // not be extended to an external bookkeeper, and was never set on the
  // production alias (which is exempt from protection), so it failed closed for
  // every real user.
  if (!(await hasSession())) {
    return {
      ok: false,
      status: 401,
      code: "no_session",
      message: "Sign in to view transaction detail.",
    };
  }

  return { ok: true, via: "first-party" };
```

Finally, update the header comment block: change line `//   4. otherwise it must look like a first-party browser fetch of this app:` sub-bullet about Vercel to read `//        - a valid Supabase session cookie must be present`.

- [ ] **Step 4: Wire the route**

In `app/api/txn/route.ts`, change the import line:
```ts
import { authorizeTxnRequest } from "@/lib/txnAuth";
```
to:
```ts
import { authorizeTxnRequest } from "@/lib/txnAuth";
import { getSessionUser } from "@/lib/supabaseServerAuth";
```

and change:
```ts
  const auth = authorizeTxnRequest(req);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);
```
to:
```ts
  const auth = await authorizeTxnRequest(req, async () => (await getSessionUser()) !== null);
  if (!auth.ok) return fail(auth.status, auth.code, auth.message);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run verify:drilldown`
Expected: `ALL CHECKS PASSED`, exit 0.

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/txnAuth.ts app/api/txn/route.ts verify/txn-drilldown.mts
git commit -m "Gate /api/txn on a Supabase session instead of Vercel protection"
```

---

### Task 4: Require a session on the two write routes

**Files:**
- Modify: `app/api/ingest/route.ts`
- Modify: `app/api/mapping/route.ts`

**Interfaces:**
- Consumes: `getSessionUser()` from Task 1
- Produces: nothing new

**Context:** `/api/ingest` currently has **no authentication at all** — it can write `fact_txn` and call `rebuild_aggregates()`. Until now only Vercel Deployment Protection stood in front of it, and that is being switched off. `/api/mapping` keeps its `ADMIN_API_TOKEN` check; a session becomes necessary but not sufficient for writes.

- [ ] **Step 1: Guard `/api/ingest`**

In `app/api/ingest/route.ts`, add to the imports:
```ts
import { getSessionUser } from "@/lib/supabaseServerAuth";
```

Immediately after `export async function POST(req: NextRequest) {`, before the body is parsed, insert:
```ts
  // This route writes fact_txn and rebuilds every aggregate the dashboard shows.
  // It had no auth of its own and relied on Vercel Deployment Protection, which
  // is no longer in front of it.
  if (!(await getSessionUser())) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to upload transaction data." },
      { status: 401 },
    );
  }
```

- [ ] **Step 2: Guard `/api/mapping`**

In `app/api/mapping/route.ts`, add to the imports:
```ts
import { getSessionUser } from "@/lib/supabaseServerAuth";
```

Insert the same check as the first statement inside **both** `export async function GET(req: NextRequest) {` and `export async function POST(req: NextRequest) {`:
```ts
  if (!(await getSessionUser())) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to view or edit account mappings." },
      { status: 401 },
    );
  }
```

Leave the existing `checkAuth`/`ADMIN_API_TOKEN` logic exactly as it is — it runs after this and remains the second factor on writes.

- [ ] **Step 3: Verify both routes refuse anonymous callers**

Run: `npx next dev -p 3111` then:

```bash
curl -sS -X POST -H 'content-type: application/json' -d '{"phase":"rows","rows":[]}' \
  -w "\n%{http_code}\n" http://localhost:3111/api/ingest
```
Expected: `{"error":"unauthenticated",...}` and `401`.

```bash
curl -sS -w "\n%{http_code}\n" http://localhost:3111/api/mapping
```
Expected: `{"error":"unauthenticated",...}` and `401`.

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/ingest/route.ts app/api/mapping/route.ts
git commit -m "Require a session on /api/ingest and /api/mapping"
```

---

### Task 5: Sign-out control

**Files:**
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `getSupabaseBrowser()` from Task 1
- Produces: nothing

**Note:** This lives in `app/page.tsx` rather than inside `Dashboard.tsx` so the dashboard component keeps its single responsibility (rendering figures) and needs no auth awareness.

- [ ] **Step 1: Add the control**

In `app/page.tsx`, add to the imports:
```tsx
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
```

Inside `export default function Page() {`, add after the existing `useState` lines:
```tsx
  const router = useRouter();

  async function signOut() {
    await getSupabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }
```

Add as the first child inside `<main className="wrap">`:
```tsx
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button onClick={signOut}>Sign out</button>
      </div>
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "Add sign-out control to the dashboard page"
```

---

### Task 6: Move RLS from anon to authenticated

**STOP — do not start this task until sign-in has been verified working in the browser (see Operational Runbook step 3). This task is the point of no return for anonymous access.**

**Files:**
- Create: `supabase/migrations/0005_auth_rls.sql`
- Create: `verify/anon-lockout.mts`
- Modify: `package.json` (add `verify:lockout` script)

**Interfaces:**
- Consumes: nothing
- Produces: `npm run verify:lockout`

- [ ] **Step 1: Write the failing test**

Create `verify/anon-lockout.mts`:

```ts
// Proves the publishable key can no longer read financial data.
//
// This is the check that actually matters. The login screen is the front door;
// this asserts the lock. Before 0005 these tables granted SELECT to anon, so
// anyone could lift the publishable key out of the browser bundle and read
// every aggregate straight from PostgREST, bypassing the app entirely.
//
//   npm run verify:lockout

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

let failures = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local");
  process.exit(2);
}

// Anonymous client: exactly what an outsider can construct from the JS bundle.
const anon = createClient(url, key, { auth: { persistSession: false } });

const TABLES = ["agg_group_month", "agg_account", "agg_vendor", "dim_facility", "map_account_group"];

console.log("== anonymous PostgREST reads (must all be empty or denied) ==");
for (const t of TABLES) {
  const { data, error } = await anon.from(t).select("*").limit(1);
  const denied = !!error || (data ?? []).length === 0;
  ok(denied, `anon cannot read ${t}`, error ? error.code || error.message : `rows=${(data ?? []).length}`);
}

// fact_txn was already private; assert it stayed that way.
{
  const { data, error } = await anon.from("fact_txn").select("*").limit(1);
  ok(!!error || (data ?? []).length === 0, "anon cannot read fact_txn", error ? error.code || error.message : `rows=${(data ?? []).length}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
```

Add to `package.json` `scripts`:
```json
    "verify:lockout": "tsx verify/anon-lockout.mts"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify:lockout`
Expected: FAIL — all five tables currently return rows to `anon`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0005_auth_rls.sql`:

```sql
-- Move the dashboard's read tables from anon to authenticated.
--
-- Until now every one of these granted SELECT to anon with USING (true). The
-- publishable key ships inside the browser bundle, so anyone could read every
-- aggregate directly from PostgREST and never touch the app. A login screen in
-- front of the dashboard would not have changed that; this migration is what
-- actually closes it.
--
-- fact_txn is deliberately untouched: it already has RLS on with zero policies
-- and is reachable only through /api/txn using the service_role key.

drop policy if exists ro_agm on public.agg_group_month;
create policy ro_agm on public.agg_group_month
  for select to authenticated using (true);

drop policy if exists ro_aa on public.agg_account;
create policy ro_aa on public.agg_account
  for select to authenticated using (true);

drop policy if exists ro_av on public.agg_vendor;
create policy ro_av on public.agg_vendor
  for select to authenticated using (true);

drop policy if exists ro_fac on public.dim_facility;
create policy ro_fac on public.dim_facility
  for select to authenticated using (true);

drop policy if exists ro_map on public.map_account_group;
create policy ro_map on public.map_account_group
  for select to authenticated using (true);

-- Belt and braces: PostgREST reaches these through the anon role, so remove the
-- table grant as well. RLS alone would suffice, but a future policy added
-- without a role clause would silently re-expose the data.
revoke select on public.agg_group_month, public.agg_account, public.agg_vendor,
                public.dim_facility, public.map_account_group
  from anon;

grant select on public.agg_group_month, public.agg_account, public.agg_vendor,
                public.dim_facility, public.map_account_group
  to authenticated;
```

- [ ] **Step 4: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool (project `gwnzktbegeseyfiofzkb`, name `auth_rls`) using the SQL above, or:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/0005_auth_rls.sql
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run verify:lockout`
Expected: `ALL CHECKS PASSED`, exit 0.

- [ ] **Step 6: Verify a signed-in browser still sees the dashboard**

In a browser at the running dev server, sign in and confirm the dashboard renders figures (total should read $22,851,611.16) and a drill-down returns rows.

Expected: dashboard populated; drill-down drawer lists transactions.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0005_auth_rls.sql verify/anon-lockout.mts package.json
git commit -m "Move aggregate table RLS from anon to authenticated"
```

---

## Operational Runbook

These are not code tasks. Run them in this order, after Tasks 1–5 and before/around Task 6.

1. **Enable the email provider and disable public signup.**
   Supabase Dashboard → Authentication → Providers → Email: enabled, "Confirm email" **off** (admin sets passwords directly).
   Authentication → Sign In / Providers → **disable "Allow new users to sign up"**. Without this, anyone could self-register and read your financials.

2. **Create the first user.**
   Authentication → Users → Add user → "Create new user". Enter email and a password; tick "Auto Confirm User".

3. **Verify sign-in end to end** against the dev server before touching RLS. Sign in, confirm the dashboard renders and a drill-down returns rows.

4. **Task 6** — apply the RLS migration, run `npm run verify:lockout`.

5. **Turn off Vercel Deployment Protection.**
   `npx vercel project protection disable --sso accounting-expenses`
   Then confirm the app is reachable and shows the login screen rather than Vercel SSO.

6. **Set env vars and deploy.** No new env vars are required — the login flow uses the existing `NEXT_PUBLIC_*` pair. Deploy, then verify sign-in and drill-down on the production alias.

7. **Optionally retire `TXN_ALLOW_UNPROTECTED`** from `.env.example`, since the code path that read it is gone.

---

## Self-Review

**Spec coverage.** Every section of the design spec maps to a task: cookie clients → Task 1; middleware + login → Task 2; `txnAuth` gate swap → Task 3; `/api/ingest` and `/api/mapping` guards → Task 4; sign-out → Task 5; RLS migration and the anon-read test → Task 6; provider config, first user, protection disable, deploy → Operational Runbook. The spec's gate-order table is implemented in Task 3 Step 3; gates 1–3 are explicitly left untouched so `verify:drilldown` keeps passing headlessly via the token path.

**Deviation from the spec, deliberate:** the spec listed the sign-out control under `components/Dashboard.tsx`. Task 5 puts it in `app/page.tsx` instead, so `Dashboard` stays purely a rendering component with no auth awareness.

**Placeholders.** None. Every code step carries literal content; no "add error handling" or "similar to Task N".

**Type consistency.** `getSessionUser()` returns `Promise<{id, email} | null>` in Task 1 and is consumed as a null-check in Tasks 3 and 4. `SessionProbe = () => Promise<boolean>` is defined in Task 3 Step 3 and matched by the `async () => session` stub in Task 3 Step 1 and the `async () => (await getSessionUser()) !== null` call site in Step 4. `getSupabaseBrowser()` keeps its existing name and signature, so Task 2 and Task 5 call it unchanged.

**Known risk.** Task 6 Step 4 is irreversible with respect to anonymous access. The STOP banner and Runbook step 3 exist to force verification first.
