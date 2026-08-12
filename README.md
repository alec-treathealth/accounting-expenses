# Accounting Expense Dashboard

Multi-entity expense dashboard for Treat Health's residential facilities, built
from the QuickBooks **"Consolidated transaction detail"** export. Next.js on
Vercel + Supabase. Drag-and-drop a new export to update the data.

## What it does

- Reads pre-aggregated spend from Supabase (`agg_group_month`, `agg_account`,
  `agg_vendor`, `dim_facility`) with the **publishable** key and renders spend by
  KPI group, by facility, a monthly trend, top vendors, and a data-quality panel.
- **Drag-and-drop ingest**: drop the QuickBooks CSV → it's parsed, classified and
  aggregated *in your browser* → the transaction rows are POSTed to `/api/ingest`
  → the server appends **only new** rows and rebuilds the aggregates.
- **Transaction drill-down**: click a KPI-group bar, a facility bar, a month
  segment, a vendor or an account and the underlying `fact_txn` rows open in a
  panel, read server-side through `/api/txn`.
- **Live-editable taxonomy** at `/admin`: change an account's KPI group and
  rebuild, without re-uploading a CSV. See below.

## Editing the account → KPI group mapping (`/admin`)

`map_account_group` is the authoritative taxonomy: `rebuild_aggregates()` derives
each transaction's KPI group by joining `fact_txn.account_label` to
`map_account_group.account_label` (see
`supabase/migrations/0003_rebuild_from_map.sql`). Correcting a mapping is
therefore a two-step operation with no CSV involved:

1. `/admin` → pick the right group for an account (sorted by materiality, with a
   filter for `Unclassified expense` / not-yet-reviewed). Setting a group marks
   the account `reviewed = true`.
2. **Rebuild aggregates** → re-derives `agg_group_month`, `agg_account` and
   `agg_vendor` from `fact_txn` + the taxonomy.

A rebuild only ever reallocates spend *between* groups. It cannot change an
amount, a transaction count, or `kind` — the function asserts that all three
aggregates still tie back to `fact_txn` exactly and aborts the whole rebuild if
they do not. Accounts are keyed by **name**, never by number.

`rebuild_aggregates()` no-ops on an empty `fact_txn` (a deliberate guard, so a
failed upload can never wipe live aggregates). While `fact_txn` is empty, mapping
edits are saved but move no dashboard number until a CSV has been ingested —
`/admin` says so explicitly rather than appearing to work.

Writes are gated by a shared secret in `ADMIN_API_TOKEN` and go only through
`/api/mapping` (server-side, service_role). Read the auth trade-offs in the header
comment of `app/api/mapping/route.ts` before relying on it.

## Scope & method (important)

- **14 RES facilities only.** Management, real-estate, billing and marketing
  entities in the export are excluded.
- **Mapped by account name, not number.** Account numbers collide across the
  80+ entities in the consolidated file (e.g. `7040` is "Payroll Taxes" in some
  and "Income from Capital One" in others), so classification keys off the
  account *name*; the number only identifies the class (5 = COGS, 6/7 = expense).
  Income, equity draws and balance-sheet accounts are excluded.
- **No double-count.** The report lists each transaction under both a funding and
  an expense account; only the expense/COGS side is summed.
- The whole pipeline reconciles to the source report **to the penny**
  (`npm run verify:parser`).

## Idempotent, cron-style ingest

The report has no stable per-row id, so each row's identity is
`(row_key, occurrence)`:

- `row_key` = FNV-1a hash of `facility, date, type, num, name, description,
  split, account, amount`.
- `occurrence` = 0-based index that distinguishes two *legitimately identical*
  transactions so they're never collapsed.

Uploading the same file twice is a no-op. A later file containing the same
history plus new transactions appends only the new ones (`ON CONFLICT DO
NOTHING`). Rows that exist in the DB for the uploaded months but are absent from
the new file (likely edited/removed upstream) are **reported, not deleted**.

## Transaction drill-down (`/api/txn`)

`fact_txn` has RLS enabled with **zero policies**, so it is unreadable with the
publishable key. `app/api/txn/route.ts` is the only read path: Node runtime,
service_role client, `no-store`.

- **A filter is mandatory.** At least one of `facility`, `month` (or
  `posted_period`), `kpi_group`, `account_label`, `vendor`. An unfiltered call is
  a `400 filter_required` — there is no full-table dump.
- **Every filter value is whitelisted** against `dim_facility`, `agg_account`,
  `agg_vendor` and the fixed KPI-group list (`month` against a regex), so no
  unbounded or injectable predicate reaches PostgREST.
- **Capped and paged**: `limit` ≤ 500 (default 100), `offset` ≤ 20 000.
- **Truthful totals**: every response carries the *true* `totals.amount` and
  `totals.count` for the whole filter, not just the page, plus a `truncated`
  flag. Amounts are summed in integer cents. The UI shows the true total, the
  figure that was clicked, and says explicitly that a page must not be
  subtotalled. Rows are keyed by `(row_key, occurrence)` and never de-duplicated.
- Read-only: this route issues no writes and never calls `rebuild_aggregates()`.

`npm run verify:drilldown -- /path/to/export.csv` builds the fact rows locally
with the real parser, runs the real filter/paging/summing code against them, and
asserts the drilled rows tie out to live `agg_group_month` to the penny.

### Drill-down authorization — needs sign-off

The app has **no application-level login**. Its only real boundary is Vercel
Deployment Protection (SSO). The gate in `lib/txnAuth.ts` is deliberately
minimal and fail-closed; it is **not** authentication:

| Layer | Effect |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` missing | `503`, no read path at all |
| `TXN_DRILLDOWN_ENABLED !== "true"` | `403` — off unless explicitly enabled |
| `TXN_DRILLDOWN_TOKEN` presented and matching | allowed (constant-time compare); a wrong or unconfigured token is `401` |
| Otherwise | must be a first-party browser fetch: `Sec-Fetch-Site: same-origin`, `Origin`/`Referer` host equal to `Host`, and on Vercel a Deployment-Protection cookie |

**What this protects against:** cross-site reads from another origin, `<img>`/
link/`curl` probes with no browser headers, drive-by scripted access, a
deployment where the flag or key was never configured, and unfiltered or
oversized dumps.

**What it does NOT protect against:** it cannot tell *which* human is asking.
Anyone who can load the dashboard can read every transaction, because
`Sec-Fetch-Site` only proves the request came from this app in a browser — not
who is driving it. If Deployment Protection is disabled, or a shared SSO account
is used, the drill-down is as open as the deployment. Per-user authorization
(who may see which facility) needs a real identity provider and is out of scope
for this PR.

## Local dev

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
npm run verify:parser        # proves the TS parser ties out to $19,709,887.26
```

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (and in
`.env.local` for local dev). `NEXT_PUBLIC_*` are inlined at build time, so they
must be present before the build.

| Variable | Exposure | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | dashboard reads |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | dashboard reads |
| `SUPABASE_URL` | server | ingest + mapping writes, drill-down reads |
| `SUPABASE_SERVICE_ROLE_KEY` | **server, secret** | ingest + mapping writes + `fact_txn` reads (never commit / never expose) |
| `TXN_DRILLDOWN_ENABLED` | server | must be `"true"` or `/api/txn` serves nothing |
| `TXN_DRILLDOWN_TOKEN` | **server, secret** | optional shared secret for scripted drill-down reads |
| `TXN_ALLOW_UNPROTECTED` | server | opt out of requiring a Deployment-Protection cookie (see above) |
| `ADMIN_API_TOKEN` | **server, secret** | gates the `/api/mapping` write path; unset ⇒ `/admin` is read-only |

## Database

Apply the migrations in `supabase/migrations/` in order:

- `0001_fact_txn.sql` — the private `fact_txn` detail table + the guarded
  `rebuild_aggregates()` function. The `agg_*` and `dim_facility` tables already
  exist in the project.
- `0003_rebuild_from_map.sql` — makes `map_account_group` authoritative for
  `kpi_group` (previously the rebuild read the group off the fact row, so editing
  the taxonomy did nothing).

## Security notes

- The service_role key is used **only** in `app/api/ingest/route.ts` and
  `app/api/txn/route.ts` (both server-only, `runtime = "nodejs"`) and is never
  sent to the browser or committed (`.gitignore` covers `.env*`).
- The aggregate tables are currently world-readable via the publishable key (a
  deliberate project decision). Gate behind Supabase Auth if that changes.
- `fact_txn` is **not** world-readable and must stay that way: no `anon` or
  `authenticated` policy. Transaction detail is served only by `/api/txn`.
