-- Exact count and sum for a drill-down filter, in ONE round trip.
--
-- fetchTxnPage computed the true total by paging the entire matched population
-- in 1000-row chunks because PostgREST cannot SUM without an RPC. Those reads are
-- SEQUENTIAL, so cost scaled with the slice: "Cost of Goods Sold" (18,841 rows)
-- cost 19 round trips, a month 8, a large facility 5 -- while the aggregate
-- itself runs in ~3ms. The latency was almost entirely round trips.
--
-- Filter semantics mirror applyFilters() in lib/txnQuery.ts EXACTLY. If these
-- drift, the drawer's reconciliation against the dashboard figure breaks
-- silently, so verify/txn-totals.mts asserts them against the raw table.
-- p_q is sanitised client-side (sanitizeQ strips % and _), so it cannot smuggle
-- LIKE wildcards.
--
-- SECURITY INVOKER on purpose: fact_txn has RLS on with zero policies, so this is
-- only useful to service_role, which is how /api/txn reads.
create or replace function public.txn_totals(
  p_facility      text    default null,
  p_posted_period date    default null,
  p_kpi_group     text    default null,
  p_account_label text    default null,
  p_vendor        text    default null,
  p_no_payee      boolean default false,
  p_q             text    default null
)
returns table (total_count bigint, total_amount numeric)
language sql
stable
set search_path = public
as $$
  select count(*)::bigint as total_count,
         coalesce(sum(t.amount), 0)::numeric as total_amount
    from public.fact_txn t
   where (p_facility      is null or t.facility      = p_facility)
     and (p_posted_period is null or t.posted_period = p_posted_period)
     and (p_kpi_group     is null or t.kpi_group     = p_kpi_group)
     and (p_account_label is null or t.account_label = p_account_label)
     and (case
            when p_no_payee then (t.name is null or t.name = '')
            when p_vendor is not null then t.name = p_vendor
            else true
          end)
     and (p_q is null
          or t.name          ilike '%' || p_q || '%'
          or t.description   ilike '%' || p_q || '%'
          or t.account_label ilike '%' || p_q || '%');
$$;

revoke all on function public.txn_totals(text, date, text, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.txn_totals(text, date, text, text, text, boolean, text)
  to service_role;
