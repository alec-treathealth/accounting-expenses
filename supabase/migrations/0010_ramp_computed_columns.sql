-- 0010_ramp_computed_columns.sql
--
-- PostgREST computed columns on fact_txn, so the drill-down's PAGE query and its
-- TOTALS query share one definition of "a Ramp charge" and "the cardholder".
--
-- WHY NOT JUST split=ilike.2030 Ramp*
-- -----------------------------------
-- Because it would only mirror is_ramp_split() FOR TODAY'S DATA. The drawer's
-- whole value is that the rows it lists sum to the figure that was clicked; the
-- moment the page predicate and the txn_totals() predicate can disagree, that
-- guarantee becomes a coincidence rather than a property. A function taking the
-- table type is exposed by PostgREST as a virtual column that can be filtered
-- on, so both paths call the SAME function and cannot drift.
--
-- Computed columns are only returned when explicitly selected, so this adds
-- nothing to the drill-down payload.
--
-- On the absence of `set search_path` here, see 0011 — it is deliberate, and
-- measured.

create or replace function public.is_ramp(public.fact_txn)
returns boolean
language sql
stable
as $$ select public.is_ramp_split($1.split); $$;

create or replace function public.ramp_cardholder(public.fact_txn)
returns text
language sql
stable
as $$ select public.ramp_person($1.description); $$;

comment on function public.is_ramp(public.fact_txn) is
  'PostgREST computed column: ?is_ramp=is.true selects Ramp card charges using the same definition as is_ramp_split().';
comment on function public.ramp_cardholder(public.fact_txn) is
  'PostgREST computed column: ?ramp_cardholder=eq.<name> selects one cardholder using the same definition as ramp_person().';

-- fact_txn is unreadable by anon/authenticated (RLS on, zero policies), so these
-- are only ever reachable through the service_role client behind /api/txn. Drop
-- the inherited PUBLIC execute anyway rather than relying on that.
revoke all on function public.is_ramp(public.fact_txn) from public, anon, authenticated;
revoke all on function public.ramp_cardholder(public.fact_txn) from public, anon, authenticated;
grant execute on function public.is_ramp(public.fact_txn) to service_role;
grant execute on function public.ramp_cardholder(public.fact_txn) to service_role;

-- PostgREST caches the schema; without this the new virtual columns 404 until
-- the next restart.
notify pgrst, 'reload schema';
