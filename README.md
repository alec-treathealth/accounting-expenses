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
| `SUPABASE_URL` | server | ingest writes |
| `SUPABASE_SERVICE_ROLE_KEY` | **server, secret** | ingest writes (never commit / never expose) |

## Database

Apply `supabase/migrations/0001_fact_txn.sql` (creates the private `fact_txn`
detail table + the guarded `rebuild_aggregates()` function). The `agg_*` and
`dim_facility` tables already exist in the project.

## Security notes

- The service_role key is used **only** in `app/api/ingest/route.ts` (server) and
  is never sent to the browser or committed (`.gitignore` covers `.env*`).
- The aggregate tables are currently world-readable via the publishable key (a
  deliberate project decision). Gate behind Supabase Auth if that changes.
