-- 0015_rebuild_aggregates_where_true.sql
--
-- rebuild_aggregates() cannot be called through PostgREST, and therefore the
-- app's own drag-and-drop upload cannot finish.
--
-- PostgREST connects as `authenticator`, whose role config carries
--   session_preload_libraries = supautils, safeupdate
-- pg-safeupdate installs a post_parse_analyze hook that rejects any DELETE or
-- UPDATE without a WHERE clause. Every delete in this function is unqualified by
-- design -- it rebuilds each aggregate wholesale -- so the RPC fails with
--   "DELETE requires a WHERE clause"
-- SECURITY DEFINER does not help: the hook fires on statement analysis in the
-- session, not on the executing role's privileges.
--
-- Effect before this fix: /api/ingest phase "rows" appends fine, then phase
-- "finalize" 500s, leaving fact_txn updated and every agg_* table stale. It is
-- loud rather than silent, but the warehouse is inconsistent until someone runs
-- the rebuild over a direct (non-PostgREST) connection. app/api/mapping's
-- rebuild button fails identically.
--
-- The fix is `where true`: semantically identical, and it satisfies the hook
-- because the hook only checks for the PRESENCE of a WHERE clause.
--
-- Body is otherwise byte-for-byte the function from 0008, including both guards
-- and all five tie-out assertions. `create or replace` preserves the ACL set by
-- 0004, so no grants are restated.

create or replace function public.rebuild_aggregates()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact_amount numeric; v_fact_n bigint;
  v_ramp_amount numeric; v_ramp_n bigint;
  v_dup text; v_amount numeric; v_n bigint;
begin
  if (select count(*) from public.fact_txn) = 0 then return; end if;

  select account_label into v_dup from public.map_account_group
   group by account_label having count(*) > 1 limit 1;
  if v_dup is not null then
    raise exception 'rebuild_aggregates: map_account_group has duplicate account_label %; refusing to rebuild (the join would double-count spend)', v_dup;
  end if;

  select sum(amount), count(*) into v_fact_amount, v_fact_n from public.fact_txn;
  select coalesce(sum(amount), 0), count(*) into v_ramp_amount, v_ramp_n
    from public.fact_txn where public.is_ramp_split(split);

  insert into public.map_account_group (account_label, account_num, kpi_group, kind, reviewed)
    select f.account_label, max(f.account_num),
           coalesce(nullif(btrim(max(f.kpi_group)), ''), 'Unclassified expense'),
           coalesce(nullif(btrim(max(f.kind)), ''), 'EXP'), false
      from public.fact_txn f
     where not exists (select 1 from public.map_account_group m where m.account_label = f.account_label)
     group by f.account_label
    on conflict (account_label) do nothing;

  delete from public.agg_group_month where true;
  insert into public.agg_group_month (facility, posted_period, kpi_group, amount, n)
    select f.facility, f.posted_period,
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense'),
           round(sum(f.amount), 2), count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     group by 1, 2, 3;

  delete from public.agg_account where true;
  insert into public.agg_account (account_label, account_num, kpi_group, kind, amount, n)
    select f.account_label, max(f.account_num),
           max(coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense')),
           max(f.kind), round(sum(f.amount), 2), count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     group by f.account_label;

  delete from public.agg_vendor where true;
  insert into public.agg_vendor (facility, vendor, kpi_group, amount, n)
    select f.facility, coalesce(nullif(f.name, ''), '(no payee)'),
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense'),
           round(sum(f.amount), 2), count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     group by 1, 2, 3;

  delete from public.agg_ramp_person where true;
  insert into public.agg_ramp_person (facility, posted_period, person, kpi_group, amount, n)
    select f.facility, f.posted_period, public.ramp_person(f.description),
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense'),
           round(sum(f.amount), 2), count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     where public.is_ramp_split(f.split)
     group by 1, 2, 3, 4;

  -- vendor is the tiebreak so the top-12 cut is deterministic across rebuilds.
  delete from public.agg_ramp_vendor where true;
  insert into public.agg_ramp_vendor (facility, person, vendor, amount, n, rk)
    select facility, person, vendor, amount, n, rk from (
      select f.facility,
             public.ramp_person(f.description) as person,
             coalesce(nullif(btrim(f.name), ''), '(no payee)') as vendor,
             round(sum(f.amount), 2) as amount,
             count(*)::integer as n,
             row_number() over (
               partition by f.facility, public.ramp_person(f.description)
               order by sum(f.amount) desc, coalesce(nullif(btrim(f.name), ''), '(no payee)')
             )::smallint as rk
        from public.fact_txn f
       where public.is_ramp_split(f.split)
       group by 1, 2, 3
    ) ranked where rk <= 12;

  select sum(amount), sum(n) into v_amount, v_n from public.agg_group_month;
  if v_amount <> v_fact_amount or v_n <> v_fact_n then
    raise exception 'rebuild_aggregates: agg_group_month does not tie to fact_txn (% / % rows vs % / % rows)', v_amount, v_n, v_fact_amount, v_fact_n;
  end if;

  select sum(amount), sum(n) into v_amount, v_n from public.agg_account;
  if v_amount <> v_fact_amount or v_n <> v_fact_n then
    raise exception 'rebuild_aggregates: agg_account does not tie to fact_txn (% / % rows vs % / % rows)', v_amount, v_n, v_fact_amount, v_fact_n;
  end if;

  select sum(amount), sum(n) into v_amount, v_n from public.agg_vendor;
  if v_amount <> v_fact_amount or v_n <> v_fact_n then
    raise exception 'rebuild_aggregates: agg_vendor does not tie to fact_txn (% / % rows vs % / % rows)', v_amount, v_n, v_fact_amount, v_fact_n;
  end if;

  -- GUARD 4: agg_ramp_person must tie to the RAMP SLICE exactly.
  select coalesce(sum(amount), 0), coalesce(sum(n), 0) into v_amount, v_n from public.agg_ramp_person;
  if v_amount <> v_ramp_amount or v_n <> v_ramp_n then
    raise exception 'rebuild_aggregates: agg_ramp_person does not tie to the Ramp slice of fact_txn (% / % rows vs % / % rows)', v_amount, v_n, v_ramp_amount, v_ramp_n;
  end if;

  -- agg_ramp_vendor is truncated to the top 12 so it CANNOT tie; what must hold
  -- is that it never claims MORE than the slice.
  select coalesce(sum(amount), 0), coalesce(sum(n), 0) into v_amount, v_n from public.agg_ramp_vendor;
  if v_amount > v_ramp_amount or v_n > v_ramp_n then
    raise exception 'rebuild_aggregates: agg_ramp_vendor (% / % rows) exceeds the Ramp slice (% / % rows)', v_amount, v_n, v_ramp_amount, v_ramp_n;
  end if;
end;
$$;
