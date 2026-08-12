-- Transaction-level detail table for idempotent, cron-style CSV ingest.
--
-- The "Consolidated transaction detail" report has no stable per-row id, so
-- identity = (row_key, occurrence): row_key is a content hash of the row, and
-- occurrence is a 0-based index that distinguishes two LEGITIMATELY identical
-- transactions (same vendor, amount, day) so they are never collapsed. Re-
-- uploading the same file is a no-op (ON CONFLICT DO NOTHING); a later file with
-- the same history plus new rows appends only the new ones.
--
-- The dashboard reads the open agg_* tables; fact_txn stays private (RLS on, no
-- anon policy). Writes happen only via the service role in /api/ingest.

create table if not exists public.fact_txn (
  row_key       text        not null,
  occurrence    int         not null,
  facility      text        not null,
  txn_date      date        not null,
  posted_period date        not null,
  txn_type      text,
  num           text,
  name          text,
  description   text,
  split         text,
  account_num   text,
  account_label text        not null,
  kpi_group     text        not null,
  kind          text,
  amount        numeric(14,2) not null,
  loaded_at     timestamptz not null default now(),
  primary key (row_key, occurrence)
);
create index if not exists fact_txn_period on public.fact_txn (posted_period);
create index if not exists fact_txn_fac    on public.fact_txn (facility);
create index if not exists fact_txn_acct   on public.fact_txn (account_label);

alter table public.fact_txn enable row level security;
-- no anon/authenticated policy: transaction detail is not world-readable.

-- Rebuild the three aggregate tables the dashboard reads, from fact_txn.
-- Guarded: if fact_txn is empty it does NOTHING, so a failed/partial upload can
-- never wipe the live aggregates.
create or replace function public.rebuild_aggregates()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.fact_txn) = 0 then
    return;
  end if;

  delete from public.agg_group_month;
  insert into public.agg_group_month (facility, posted_period, kpi_group, amount, n)
    select facility, posted_period, kpi_group, round(sum(amount), 2), count(*)
      from public.fact_txn group by 1, 2, 3;

  delete from public.agg_account;
  insert into public.agg_account (account_label, account_num, kpi_group, kind, amount, n)
    select account_label, max(account_num), max(kpi_group), max(kind), round(sum(amount), 2), count(*)
      from public.fact_txn group by account_label;

  delete from public.agg_vendor;
  insert into public.agg_vendor (facility, vendor, kpi_group, amount, n)
    select facility, coalesce(nullif(name, ''), '(no payee)'), kpi_group, round(sum(amount), 2), count(*)
      from public.fact_txn group by 1, 2, 3;
end;
$$;

revoke all on function public.rebuild_aggregates() from anon, authenticated;
