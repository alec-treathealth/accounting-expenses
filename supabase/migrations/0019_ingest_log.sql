-- When was the warehouse last fed? The top bar's freshness tag used to be a
-- string constant in the bundle, which meant every CSV upload silently made it
-- a lie until someone edited code. The ingest route now appends a row here
-- after each successful rebuild, and the dashboard reads the newest one.
--
-- Append-only ON PURPOSE: a log of uploads is also a cheap audit trail, and a
-- single-row "last updated" cell would erase it for no saving worth having.

create table if not exists public.ingest_log (
  id          bigint generated always as identity primary key,
  uploaded_at timestamptz not null default now(),
  -- Which pipeline fed the warehouse. Free text so a future QBO sync can
  -- stamp itself without a migration.
  source      text not null default 'csv-upload'
);

comment on table public.ingest_log is
  'One row per successful warehouse rebuild. The dashboard''s "data last '
  'updated" tag is the newest uploaded_at. Written only by the ingest route '
  '(service role); dashboard members read it.';

-- Same access model as every other read table (see 0005): RLS on, membership
-- of app_access — not merely a session — is what grants the read. Writes come
-- from the ingest route's service role, which bypasses RLS; no insert policy
-- or grant exists on purpose.
alter table public.ingest_log enable row level security;

drop policy if exists ro_ingest_log on public.ingest_log;
create policy ro_ingest_log on public.ingest_log
  for select to authenticated using (public.has_dashboard_access());

revoke all on public.ingest_log from public, anon;
grant select on public.ingest_log to authenticated;

-- Backfill the ingests that predate this table with the one fact the warehouse
-- already holds: when the newest surviving row landed (fact_txn.loaded_at).
-- Derived at apply time, never a literal — a timestamp written here by hand is
-- a guess, and goes stale the moment another upload lands before the migration
-- runs. HAVING guards the empty-warehouse case: no rows, no stamp.
insert into public.ingest_log (uploaded_at, source)
select max(loaded_at), 'csv-upload (backfilled from fact_txn.loaded_at)'
  from public.fact_txn
having max(loaded_at) is not null;
