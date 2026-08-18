# Supabase Auth for the Expense Dashboard

**Date:** 2026-08-12
**Status:** Approved, pending implementation
**Branch:** `feat/treat-design-system`

## Problem

The dashboard is publicly reachable and the transaction drill-down is unreachable. Both stem from the same gap: the app has no application-level authentication.

1. **Data is public.** `agg_account`, `agg_group_month`, `agg_vendor`, `dim_facility`, and `map_account_group` all carry RLS policies granting `SELECT` to `anon` with `qual: true`. The publishable key ships in the browser bundle, so anyone can read every aggregate directly from PostgREST, bypassing the app entirely.
2. **Drill-down returns 401.** `authorizeTxnRequest` gate 4 (`lib/txnAuth.ts:123`) requires a Vercel Deployment Protection cookie. The production alias is exempt from protection (`ssoProtection.deploymentType` excludes production domains), so no cookie is ever set and the gate fails closed with `no_platform_session`.

Gating on Vercel Deployment Protection also ties access to Vercel team membership, which cannot be extended to an external bookkeeper or accountant.

## Decisions

| Decision | Choice |
|---|---|
| Sign-in method | Per-user email + password, invite-only |
| Account creation | Admin creates users; public signup disabled |
| Roles | None — every signed-in user can view, drill down, upload CSVs, and edit mappings |
| Vercel Deployment Protection | Turned off; Supabase Auth becomes the gate |
| Session transport | Cookies via `@supabase/ssr` |
| Email/SMTP | Not required — no magic links. Password resets are handled by an admin setting a new password |

Rejected: magic links (email delivery becomes a single point of failure), a single shared password (no per-person revocation or attribution, and forces every read server-side), and a full server-side proxy (rewrites every dashboard query for marginal gain once `anon` is revoked).

## Amendment (2026-08-12, during implementation)

The design below assumed public signup would be disabled, making "authenticated"
a safe proxy for "invited". That assumption proved false and unfixable from here:

- Public signup is **enabled** on this project. Verified by POSTing to
  `/auth/v1/signup` with the publishable key — it returned 200 and created a
  user. Disabling it requires the Supabase dashboard or Management API.
- `/api/txn` reads `fact_txn` with the **service_role** key, which bypasses RLS
  entirely. No policy can protect that route; only application code can.

So access is granted by membership of a `public.app_access` invite list, not by
merely holding a session. `has_dashboard_access()` (SECURITY DEFINER) backs both
the RLS policies and the server-side check in `getAuthorizedUser()`. This is what
"invite-only" — the choice actually made — requires, and it holds even if someone
re-enables signup later. Disabling public signup remains recommended, but is now
defence in depth rather than the security boundary.

## Architecture

Supabase Auth with the email+password provider. Sessions live in cookies rather than localStorage so that both the browser and Next.js route handlers can read them. Middleware refreshes the session on each request and redirects unauthenticated page requests to `/login`.

The security boundary is the RLS change, not the login screen. Moving the five read tables from `anon` to `authenticated` is what makes the publishable key useless to an outsider. The login page is the front door; the policy change is the lock.

`fact_txn` already follows the target model — RLS on, zero policies, reachable only through `/api/txn` using the service-role key. This design extends that model to the aggregate tables.

### Two server clients, kept separate

- `lib/supabaseServer.ts` (existing, unchanged) — service-role admin client. Bypasses RLS. Used by `/api/txn`, `/api/ingest`, `/api/mapping`.
- `lib/supabaseServerAuth.ts` (new) — cookie-reading client used only to answer "who is this request?". Never used to read data.

Keeping these separate prevents the service-role key from ever being reached through a request-scoped code path.

## Components

| Change | File |
|---|---|
| Add `@supabase/ssr` | `package.json` |
| `createClient` → `createBrowserClient`, cookie storage, `persistSession` enabled | `lib/supabaseBrowser.ts` |
| **New** — `createServerClient` reading request cookies | `lib/supabaseServerAuth.ts` |
| **New** — session refresh + page guard | `middleware.ts` |
| **New** — email + password form | `app/login/page.tsx` |
| Replace Vercel-session gate with Supabase session check | `lib/txnAuth.ts` |
| **Add auth — currently has none** | `app/api/ingest/route.ts` |
| Add session requirement alongside `ADMIN_API_TOKEN` | `app/api/mapping/route.ts` |
| Sign-out control | `components/Dashboard.tsx` |
| **New** — RLS `anon` → `authenticated` | `supabase/migrations/0005_auth_rls.sql` |

`/api/mapping` keeps its existing `ADMIN_API_TOKEN` check for writes. A session becomes necessary but not sufficient for mutations; the token remains the second factor on the destructive path.

## Data flow

1. Request for `/` with no session → middleware redirects to `/login`.
2. User submits email + password → `signInWithPassword` → session cookie set.
3. Redirect to `/` → middleware refreshes the session → `Dashboard` renders.
4. `Dashboard` queries `agg_*` and `dim_facility` directly from the browser, now carrying a user JWT. RLS admits the request as `authenticated`. **No query code changes.**
5. Clicking a KPI bar or facility → `fetch /api/txn` → route resolves the session from the cookie → authorized → service-role client reads `fact_txn` → rows returned.

## Gate order in `authorizeTxnRequest` after the change

1. No `SUPABASE_SERVICE_ROLE_KEY` → 503 `not_configured` *(unchanged)*
2. `TXN_DRILLDOWN_ENABLED !== "true"` → 403 `drilldown_disabled` *(unchanged)*
3. Presented `x-drilldown-token` matching `TXN_DRILLDOWN_TOKEN` → allow *(unchanged — keeps ops scripts and `verify:drilldown` working headlessly)*
4. **Valid Supabase session → allow** *(replaces the Vercel Deployment Protection check)*
5. Otherwise → 401 `unauthenticated`

Retaining gates 1–3 means no verification script or cron path breaks.

## Error handling

| Condition | Behaviour |
|---|---|
| Wrong password | Inline error on the login form; no distinction between unknown email and bad password |
| Expired session | Middleware attempts refresh; on failure, redirect to `/login` |
| `/api/txn` without a session | JSON 401 `unauthenticated` — the shape `TxnDrawer` already renders |
| `/api/ingest` or `/api/mapping` without a session | JSON 401, no mutation attempted |
| Supabase Auth unreachable | Login form surfaces the error rather than hanging; dashboard stays inaccessible (fail closed) |

## Testing

The test that matters is not the login screen. It is confirming the publishable key can no longer read data:

```
curl "$SUPABASE_URL/rest/v1/agg_group_month?select=*" -H "apikey: $PUBLISHABLE_KEY"
# must return zero rows / permission denied after 0005 is applied
```

Also verify:
- Signed-out page request redirects to `/login`
- Signed-in drill-down returns rows and reconciles (`totals.exact === true`)
- `verify/txn-drilldown.mts` and `verify/txn-search.mts` still pass via the gate-3 token path
- Sign-out clears the cookie and re-blocks the dashboard

## Sequencing

Ordering is load-bearing. Flipping RLS before sign-in works locks everyone, including the operator, out of the dashboard with no recovery path through the UI.

1. Add `@supabase/ssr`, browser/server clients, middleware, `/login`
2. Update `txnAuth.ts`, `/api/ingest`, `/api/mapping`
3. Create the first user (Supabase dashboard, or admin API with the service-role key)
4. **Verify sign-in works end to end**
5. Apply `0005_auth_rls.sql` — RLS `anon` → `authenticated`
6. Confirm the anonymous PostgREST read now fails
7. Turn off Vercel Deployment Protection
8. Deploy

Step 5 is the point of no return for anonymous access. Step 4 must pass first.

## Out of scope

- Roles and permissions (explicitly deferred; revisit if non-staff are ever given access)
- Custom SMTP / password-reset email
- Self-service signup
- Auditing who viewed which transactions
- Closing the pre-existing gap that `/api/ingest` has no rate limiting

## Follow-up, tracked separately

`lib/classify.ts` currently has uncommitted changes adding California Treatment Collective and Dallas Mental Health to the `FACILITY` map. The dashboard already reflects both facilities because it reads from the database, but a CSV re-uploaded through the UI would drop them until that change ships.
