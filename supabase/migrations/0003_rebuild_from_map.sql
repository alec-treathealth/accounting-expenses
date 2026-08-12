-- 0003_rebuild_from_map.sql
--
-- Make public.map_account_group AUTHORITATIVE for kpi_group.
--
-- THE BUG
-- -------
-- 0001 rebuilt the three agg_* tables straight off fact_txn.kpi_group:
--
--     select facility, posted_period, kpi_group, ... from public.fact_txn group by 1,2,3
--
-- fact_txn.kpi_group is computed in the BROWSER at upload time by classify()
-- in lib/classify.ts, so map_account_group was never consulted by the rebuild
-- at all. Editing the taxonomy changed nothing, and the only way to move an
-- account into a different KPI group was to change classify() and re-upload the
-- whole CSV. The dashboard's claim that "the map_account_group table holds the
-- taxonomy; each upload rebuilds from it" was false. This migration makes it
-- true: the group is resolved by joining fact_txn.account_label to
-- map_account_group.account_label, and classify()'s output survives only as the
-- fallback for account labels the map has never seen.
--
-- THE RESOLUTION EXPRESSION (appears once per insert, must stay in sync)
-- ---------------------------------------------------------------------
--     coalesce(
--       nullif(btrim(m.kpi_group), ''),  -- 1. the map wins
--       nullif(btrim(f.kpi_group), ''),  -- 2. else classify()'s guess on the fact row
--       'Unclassified expense')          -- 3. else the explicit catch-all bucket
--
-- Two properties are deliberate and load-bearing:
--   * LEFT join, never inner: an account_label with no map row must still be
--     COUNTED, at its fact-row group. A rebuild must never silently drop spend.
--   * coalesce down to a literal: kpi_group is NOT NULL in all three agg_*
--     tables, and a NULL group would abort the whole rebuild. Nothing here can
--     produce NULL or ''.
--
-- Classification stays keyed on the account NAME (account_label), never the
-- number: account numbers collide across the 80+ consolidated entities (7040 is
-- "Payroll Taxes" in one entity and "Income from Capital One" in another).
--
-- WHY THIS CANNOT MOVE THE GRAND TOTAL
-- ------------------------------------
-- The join is many-to-one: map_account_group.account_label is its PRIMARY KEY,
-- so each fact row matches at most one map row and the row set being summed is
-- unchanged. Only the GROUP BY key changes, which reallocates spend BETWEEN
-- groups. amount is numeric(14,2) in both fact_txn and the agg_* tables, so the
-- per-group sums are exact and round(...,2) is a no-op -- the assertions at the
-- bottom of the function can therefore test for exact equality, not a tolerance.
--
-- Preserved from 0001, unchanged: security definer, set search_path = public,
-- the revoke from anon/authenticated, the empty-fact_txn guard, agg_account
-- grouping by account_label, and agg_vendor's coalesce(nullif(name,''),'(no
-- payee)'). kind is still taken off the fact row (max(f.kind)) and is NOT read
-- from map_account_group.kind: kind is a source-derived property of the account
-- number class (5 = COGS, 6/7 = EXP), not a taxonomy decision, and this
-- migration must not change it.

create or replace function public.rebuild_aggregates()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact_amount numeric;
  v_fact_n      bigint;
  v_dup         text;
  v_amount      numeric;
  v_n           bigint;
begin
  -- GUARD 1 (from 0001, KEEP): never rebuild from an empty fact table, so a
  -- failed or partial upload can never wipe the live aggregates.
  if (select count(*) from public.fact_txn) = 0 then
    return;
  end if;

  -- GUARD 2 (new): the join below is only safe because account_label is unique
  -- in map_account_group. If that ever stops being true, one fact row would
  -- match several map rows and its amount would be counted more than once.
  -- Fail loudly instead of quietly inflating the financials.
  select account_label into v_dup
    from public.map_account_group
   group by account_label having count(*) > 1
   limit 1;
  if v_dup is not null then
    raise exception
      'rebuild_aggregates: map_account_group has duplicate account_label %; refusing to rebuild (the join would double-count spend)', v_dup;
  end if;

  select sum(amount), count(*) into v_fact_amount, v_fact_n from public.fact_txn;

  -- Surface brand-new account labels in the taxonomy so they can be reviewed in
  -- the admin UI instead of being invisible. Insert-only and ON CONFLICT DO
  -- NOTHING: an existing map row -- i.e. a human's decision -- is never
  -- overwritten. The seeded group is classify()'s guess, with reviewed = false,
  -- so it shows up in the "needs review" filter. This writes to the taxonomy
  -- table but cannot change any amount: it only ever adds rows for labels that
  -- already exist in fact_txn, and those rows resolve to the group they would
  -- have fallen back to anyway.
  insert into public.map_account_group (account_label, account_num, kpi_group, kind, reviewed)
    select f.account_label,
           max(f.account_num),
           coalesce(nullif(btrim(max(f.kpi_group)), ''), 'Unclassified expense'),
           coalesce(nullif(btrim(max(f.kind)), ''), 'EXP'),
           false
      from public.fact_txn f
     where not exists (
             select 1 from public.map_account_group m
              where m.account_label = f.account_label)
     group by f.account_label
    on conflict (account_label) do nothing;

  delete from public.agg_group_month;
  insert into public.agg_group_month (facility, posted_period, kpi_group, amount, n)
    select f.facility,
           f.posted_period,
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense'),
           round(sum(f.amount), 2),
           count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     group by 1, 2, 3;

  delete from public.agg_account;
  insert into public.agg_account (account_label, account_num, kpi_group, kind, amount, n)
    select f.account_label,
           max(f.account_num),
           max(coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense')),
           max(f.kind),
           round(sum(f.amount), 2),
           count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     group by f.account_label;

  delete from public.agg_vendor;
  insert into public.agg_vendor (facility, vendor, kpi_group, amount, n)
    select f.facility,
           coalesce(nullif(f.name, ''), '(no payee)'),
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense'),
           round(sum(f.amount), 2),
           count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     group by 1, 2, 3;

  -- GUARD 3 (new): re-grouping must be value-preserving. Every fact row lands in
  -- exactly one bucket of each aggregate, so both the money and the transaction
  -- count have to tie back to fact_txn exactly. A mismatch means the join
  -- dropped or duplicated rows; raising here rolls the whole rebuild back and
  -- leaves the previous aggregates in place.
  select sum(amount), sum(n) into v_amount, v_n from public.agg_group_month;
  if v_amount <> v_fact_amount or v_n <> v_fact_n then
    raise exception 'rebuild_aggregates: agg_group_month does not tie to fact_txn (% / % rows vs % / % rows)',
      v_amount, v_n, v_fact_amount, v_fact_n;
  end if;

  select sum(amount), sum(n) into v_amount, v_n from public.agg_account;
  if v_amount <> v_fact_amount or v_n <> v_fact_n then
    raise exception 'rebuild_aggregates: agg_account does not tie to fact_txn (% / % rows vs % / % rows)',
      v_amount, v_n, v_fact_amount, v_fact_n;
  end if;

  select sum(amount), sum(n) into v_amount, v_n from public.agg_vendor;
  if v_amount <> v_fact_amount or v_n <> v_fact_n then
    raise exception 'rebuild_aggregates: agg_vendor does not tie to fact_txn (% / % rows vs % / % rows)',
      v_amount, v_n, v_fact_amount, v_fact_n;
  end if;
end;
$$;

-- Carried over from 0001 for parity. NOTE: on its own this line does NOT make
-- the function unreachable with the publishable key -- Postgres grants EXECUTE
-- to PUBLIC by default on a new function, and anon/authenticated inherit it
-- through PUBLIC, which a revoke naming those roles does not remove. The PUBLIC
-- grant is revoked in 0004_lock_down_rebuild_privileges.sql. `create or replace
-- function` preserves the existing ACL, so this file is order-independent with
-- respect to 0004. Deliberately no grant execute ... to anon/authenticated here:
-- the rebuild is service_role-only, reached exclusively through the server
-- routes /api/ingest and /api/mapping.
revoke all on function public.rebuild_aggregates() from anon, authenticated;
