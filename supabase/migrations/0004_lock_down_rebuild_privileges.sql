-- Lock down rebuild_aggregates() and drop write grants the browser roles never need.
--
-- 0001 tried to keep the rebuild server-only with:
--
--   revoke all on function public.rebuild_aggregates() from anon, authenticated;
--
-- That is ineffective. Postgres grants EXECUTE on a new function to PUBLIC by
-- default, and anon/authenticated inherit it through PUBLIC; revoking from a
-- role does not remove a PUBLIC grant. The function's ACL was
--
--   =X/postgres | postgres=X/postgres | service_role=X/postgres
--
-- where the leading "=X/" entry is PUBLIC. Verified before this migration:
--
--   has_function_privilege('anon','public.rebuild_aggregates()','EXECUTE') -> true
--
-- Because the function is SECURITY DEFINER and owned by postgres (BYPASSRLS),
-- anyone holding the publishable key — which is public by design, inlined into
-- the client bundle — could POST /rest/v1/rpc/rebuild_aggregates and trigger a
-- full DELETE + rebuild of all three agg_* tables.
--
-- This was harmless only because fact_txn is empty, so the function's guard
-- returns before touching anything. But that guard only covers an EMPTY
-- fact_txn, not a PARTIAL one: once transaction detail is loaded, an
-- unauthenticated caller could rebuild the live aggregates from an incomplete
-- fact_txn and silently break reconciliation to the source report. Apply this
-- BEFORE the first CSV ingest.

-- 1. The rebuild is a server-side operation. service_role only.
revoke all on function public.rebuild_aggregates() from public;
revoke all on function public.rebuild_aggregates() from anon, authenticated;
grant execute on function public.rebuild_aggregates() to service_role;

-- 2. Defence in depth on the tables. RLS already blocks writes from the browser
-- roles, because every policy is SELECT-only (ro_agm / ro_aa / ro_av / ro_fac /
-- ro_map, all USING (true), cmd = SELECT). But anon and authenticated still hold
-- INSERT/UPDATE/DELETE/TRUNCATE grants inherited from the default schema grants,
-- so a future policy added as FOR ALL instead of FOR SELECT would immediately
-- become writable. Remove the grants the dashboard does not use and keep SELECT,
-- which is what the publishable key legitimately needs.
revoke insert, update, delete, truncate, references, trigger
  on public.agg_group_month, public.agg_account, public.agg_vendor,
     public.dim_facility, public.map_account_group
  from anon, authenticated;

-- 3. fact_txn is transaction-level detail and is not browser-readable at all.
-- RLS with zero policies already yields no rows; drop the grants too so the
-- table is not one careless policy away from being exposed. Reads for the
-- drill-down go through the service_role client in a server route.
revoke all on public.fact_txn from anon, authenticated;

-- service_role is deliberately untouched: it bypasses RLS and is used only by
-- the server-side ingest and drill-down routes, never in the browser.
