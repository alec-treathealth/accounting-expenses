-- 0011_ramp_function_inlining.sql
--
-- The four Ramp functions deliberately do NOT set search_path. This file exists
-- to record why, because the Supabase security linter flags each one with
-- `function_search_path_mutable` and the obvious "fix" is a serious regression.
-- Without this note the next person to run the linter will helpfully undo it.
--
-- WHAT WAS TRIED
-- --------------
-- All four were given `SET search_path = ''`. The linter went quiet. A filtered
-- drill-down (?is_ramp=is.true&ramp_cardholder=eq.<name>) then went from
-- 0.29-0.59s to a flat 3.0s — measured four times, no variance. That is a 10x
-- regression on the single most-used interaction in the app, and it was caught
-- only because the timing was measured rather than assumed.
--
-- WHY: any SET clause makes a SQL function non-inlinable (inline_function()
-- refuses when proconfig is non-null). Inlined, is_ramp/ramp_cardholder fold
-- into the query plan as plain expressions over the scanned row. Not inlined,
-- they become 29,864 real function invocations per scan.
--
-- WHY THE WARNING IS ACCEPTABLE HERE
-- ----------------------------------
-- search_path pinning defends against an attacker shadowing a referenced object
-- with one of their own earlier in the path. These four reference:
--   * no tables, no views, no sequences;
--   * SQL constructs (coalesce, nullif) that are not resolvable functions;
--   * btrim, regexp_replace and split_part, which live in pg_catalog — searched
--     IMPLICITLY and FIRST, ahead of anything search_path can name, so they
--     cannot be shadowed;
--   * each other, always schema-qualified as public.<fn>.
-- There is nothing for a hostile search_path to redirect.
--
-- The two functions that DO read tables — ramp_alerts() and txn_totals() — both
-- set `search_path = public` and are granted to service_role only. Those are the
-- ones where it matters, and they have it.
--
-- REVISIT IF any of these ever references a table, a view, or a function outside
-- pg_catalog. At that point pin search_path and pay the inlining cost, or lift
-- the logic into the caller.

create or replace function public.is_ramp_split(p_split text)
returns boolean language sql immutable parallel safe
as $$
  select coalesce(btrim(p_split) ~* '^2030[[:space:]]+ramp([[:space:]]|$)', false);
$$;

create or replace function public.ramp_person(p_description text)
returns text language sql immutable parallel safe
as $$
  select coalesce(
           nullif(btrim(regexp_replace(split_part(coalesce(p_description, ''), ' - ', 1),
                                       '\s+', ' ', 'g')), ''),
           '(unattributed)');
$$;

create or replace function public.is_ramp(public.fact_txn)
returns boolean language sql stable
as $$ select public.is_ramp_split($1.split); $$;

create or replace function public.ramp_cardholder(public.fact_txn)
returns text language sql stable
as $$ select public.ramp_person($1.description); $$;

-- `create or replace` preserves an existing ACL, but these run after a possible
-- re-create in 0010, so restate the grants rather than assume.
revoke all on function public.is_ramp(public.fact_txn) from public, anon, authenticated;
revoke all on function public.ramp_cardholder(public.fact_txn) from public, anon, authenticated;
grant execute on function public.is_ramp(public.fact_txn) to service_role;
grant execute on function public.ramp_cardholder(public.fact_txn) to service_role;

notify pgrst, 'reload schema';
