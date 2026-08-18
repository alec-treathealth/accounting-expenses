# Accounting Expense Dashboard

Multi-entity expense dashboard for Treat Health's residential facilities, built
from the QuickBooks **"Consolidated transaction detail"** export. Next.js on
Vercel + Supabase. Drag-and-drop a new export to update the data.

## What it does

- Reads pre-aggregated spend from Supabase (`agg_group_month`, `agg_account`,
  `agg_vendor`, `dim_facility`) with the **publishable** key and renders spend by
  KPI group, by facility, a monthly trend, top vendors, and a data-quality panel.
- **Spend KPIs**: *COGS + Expenses* (everything, and the figure that ties to
  `fact_txn`) and *Operating Expenses* (the same figure less Cost of Goods Sold),
  plus *Cost per bed* — cumulative spend over the selected range divided by
  licensed capacity. Cost per bed is per **BED, not per client**: there is no
  census or occupancy anywhere in this database. All three come from one helper,
  `lib/spend.ts`, so they cannot disagree.
- **Card Spend** (`/intelligence`) ranks Ramp charges by cardholder. Six shared
  exec/admin cards are hidden from that breakdown ONLY — they buy across many
  entities, so a per-cardholder view misattributes them. The filter is applied at
  the warehouse read (`EXCLUDED_RAMP_CARDHOLDERS` in `lib/ramp.ts`); no stored row
  changes and their spend stays in every other view under their own names.
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

- **RES facilities only.** Management, real-estate, billing and marketing
  entities in the export are excluded. `dim_facility` is the roster (18 rows);
  `lib/classify.ts` `FACILITY` is what actually admits a row to `fact_txn`. **Both
  are needed and they must agree** — a facility missing from `FACILITY` has every
  one of its rows parsed and then silently dropped, and no reconciliation
  notices, because the dropped rows are absent from both sides of the tie-out.
  That is exactly how Red Rock Behavioral Health sat at $0 while being fully
  present in the source (see `0013`).
- **Mapped by account name, not number.** Account numbers collide across the
  80+ entities in the consolidated file (e.g. `7040` is "Payroll Taxes" in some
  and "Income from Capital One" in others), so classification keys off the
  account *name*; the number only identifies the class (5 = COGS, 6/7 = expense).
  Income, equity draws and balance-sheet accounts are excluded.
- **No double-count.** The report lists each transaction under both a funding and
  an expense account; only the expense/COGS side is summed.
- **Company vs account comes from the report's own structure, never from the
  name.** Each section is closed by a `Total for <name>` row, so `lib/parse.ts`
  tracks the nesting as a stack: depth 1 is the company, depth 2 the account.
  The earlier rule — *"an account starts with a digit"* — read
  `DON'T USE! Due To R&B Mgmt (deleted)` as a company and silently dropped every
  Nashville Mental Health account after it, 6,381 rows, for months.
  **A tie-out cannot catch this**: the dropped rows are missing from both sides,
  so every aggregate still reconciled to the penny. The parser now records
  structural anomalies and the upload dialog refuses a file that has any.
- The whole pipeline reconciles to the source report **to the penny**, and
  independently: every one of the 1,756 `(company, account)` sections is checked
  against the subtotal the report itself prints, which does not depend on the
  parser's own row loop being correct.

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
npm run verify:parser        # parser total matches a known export (scripts/verify.mts)
npm run verify:spend         # the two spend cards + Cost per Bed, against live data
npm run verify:ramp          # Ramp by cardholder, incl. the excluded shared cards
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
- `0013_dim_facility_red_rock.sql` — adds Red Rock Behavioral Health to the
  roster. Pair it with the `FACILITY` entry in `lib/classify.ts` or it does
  nothing.
- `0014_dim_facility_beds.sql` — `dim_facility.beds`, licensed capacity for the
  Cost per Bed KPI. **Nullable, and the NULL means something**: no bed count on
  file. Readers must disclose such a facility, never treat it as zero.

- `0015_rebuild_aggregates_where_true.sql` — the `authenticator` role preloads
  `safeupdate`, which rejects an unqualified `DELETE`. Every delete in
  `rebuild_aggregates()` is unqualified by design, so the RPC failed with
  *"DELETE requires a WHERE clause"* — meaning `/api/ingest` phase `finalize`,
  and the `/admin` rebuild button, could not complete. `where true` satisfies the
  hook and changes nothing else.
- `0016_revoke_agg_ramp_write_grants.sql` — `agg_ramp_person`, `agg_ramp_vendor`
  and `app_access` carried table-level write grants for `anon`/`authenticated`
  that no other table has. RLS already refused the writes; this removes the grant
  behind it.
- `0017_dim_facility_notes_after_parser_fix.sql` — corrects the Nashville note,
  which recorded a parser bug as an accounting fact, and marks St. Louis as
  carried-forward and frozen.

## Security notes

- The service_role key is used **only** in `app/api/ingest/route.ts` and
  `app/api/txn/route.ts` (both server-only, `runtime = "nodejs"`) and is never
  sent to the browser or committed (`.gitignore` covers `.env*`).
- The aggregate tables are currently world-readable via the publishable key (a
  deliberate project decision). Gate behind Supabase Auth if that changes.
- `fact_txn` is **not** world-readable and must stay that way: no `anon` or
  `authenticated` policy. Transaction detail is served only by `/api/txn`.
