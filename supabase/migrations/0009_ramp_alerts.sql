-- 0009_ramp_alerts.sql
--
-- "Out of the norm" Ramp charges, plus the two drill-down filters the Expense
-- Intelligence page needs.
--
-- SERVER-ONLY, DELIBERATELY
-- -------------------------
-- ramp_alerts() returns TRANSACTION-GRAIN rows -- a date, a merchant, an amount,
-- a named person. That is the same class of data as fact_txn, which has had RLS
-- on with zero policies since 0001 and is reachable only through /api/txn with
-- the service_role key. Materialising alerts into a browser-readable agg_* table
-- would have punched a hole in that boundary for the sake of one round trip. So
-- this is security definer, granted to service_role alone, and reached through
-- /api/alerts behind the same authorization as /api/txn.
--
-- COMPUTED, NEVER STORED
-- ----------------------
-- No alerts table, no dismissal state. Re-ingest re-derives everything; there is
-- nothing to migrate and nothing to go stale. Dismissal is real state and a real
-- feature, and it is not in scope.
--
-- THRESHOLDS WERE MEASURED, NOT GUESSED
-- -------------------------------------
-- Against the live warehouse (Apr 1 - Aug 11 2026, 24,226 Ramp rows):
--   large charge     92 findings
--   monthly spike    11 findings
--   duplicate        32 findings
-- ~135 over five months, ~27 a month. A feed nobody can finish is a feed nobody
-- reads, so volume is part of the design, not an accident of the rule.
--
-- Every rule is PERSON-RELATIVE with an absolute floor underneath. A $900 charge
-- is unremarkable for someone whose median is $500 and extraordinary for someone
-- whose median is $18; a pure absolute threshold cannot say that, and a pure
-- relative one fires on a $40 lunch for someone whose median is $4.

create or replace function public.ramp_alerts()
returns table (
  kind          text,
  severity      text,
  facility      text,
  posted_period date,
  txn_date      date,
  person        text,
  vendor        text,
  account_label text,
  kpi_group     text,
  amount        numeric,
  n             integer,
  baseline      numeric,
  excess        numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with ramp as (
    -- kpi_group resolved through map_account_group exactly as rebuild_aggregates
    -- does, so an alert's group always matches the dashboard's.
    select f.facility,
           f.posted_period,
           f.txn_date,
           public.ramp_person(f.description)                 as person,
           coalesce(nullif(btrim(f.name), ''), '(no payee)') as vendor,
           f.account_label,
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''),
                    'Unclassified expense')                  as kpi_group,
           f.amount
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     where public.is_ramp_split(f.split)
       -- Credits and refunds are not overspending. 196 rows are negative; a
       -- refund landing in an "unusually large" feed trains the user to dismiss.
       and f.amount > 0
  ),

  -- A person's own typical charge. Median, not mean: one $18,628 charge would
  -- drag a mean high enough to hide the next one.
  --
  -- The ::numeric cast is REQUIRED, not stylistic. Postgres ships no numeric
  -- variant of percentile_cont -- only (double precision) and (interval) -- so
  -- a numeric column is implicitly cast to float8 and the result comes back
  -- float8. Without the cast, round(m, 2) fails to resolve
  -- ("function round(double precision, integer) does not exist") and every
  -- comparison downstream would be float arithmetic on money.
  med as (
    select person,
           (percentile_cont(0.5) within group (order by amount))::numeric as m,
           count(*)                                                       as n
      from ramp
     group by person
  ),

  -- RULE 1 -- large charge.
  -- >= 10x the person's median AND >= $2,500, and only for people with >= 12
  -- charges, because a median over three rows is not a norm.
  large as (
    select 'large_charge'::text as kind,
           r.facility, r.posted_period, r.txn_date, r.person, r.vendor,
           r.account_label, r.kpi_group,
           round(r.amount, 2)                as amount,
           1::integer                        as n,
           round(med.m, 2)                   as baseline,
           round(r.amount - med.m, 2)        as excess
      from ramp r
      join med on med.person = r.person
     where med.n >= 12
       and r.amount >= greatest(10 * med.m, 2500)
  ),

  -- RULE 2 -- monthly spike.
  -- Per (facility, person) rather than per person, so every alert carries the
  -- facility the page filters on.
  pm as (
    select facility, person, posted_period,
           sum(amount) as amt, count(*)::integer as n
      from ramp
     group by 1, 2, 3
  ),
  spike as (
    select 'monthly_spike'::text as kind,
           facility, posted_period,
           null::date            as txn_date,
           person,
           null::text            as vendor,
           null::text            as account_label,
           null::text            as kpi_group,
           round(amt, 2)         as amount,
           n,
           round(prior_avg, 2)   as baseline,
           round(amt - prior_avg, 2) as excess
      from (
        select facility, person, posted_period, amt, n,
               avg(amt)  over w as prior_avg,
               count(*)  over w as prior_months
          from pm
        window w as (partition by facility, person order by posted_period
                     rows between unbounded preceding and 1 preceding)
      ) s
     where prior_months >= 2
       and prior_avg > 0
       and amt >= 2 * prior_avg
       and amt - prior_avg >= 1000
  ),

  -- RULE 3 -- possible duplicate.
  --
  -- THE ROUTINE-RECURRENCE EXCLUSION IS LOAD-BEARING. Without it the rule fires
  -- 446 times at >= $250, and 414 of those are 'Google Ads' at exactly $500.00
  -- against '6010 PPC- Pay Per Click' -- an ad-platform daily budget cap, charged
  -- repeatedly BY DESIGN. Shipping that would bury 32 real findings under 414
  -- false ones and teach the user to ignore the badge inside a day.
  --
  -- So a (person, vendor, amount) triple seen on 3+ DISTINCT DAYS is recurring by
  -- definition and can never raise a duplicate. 446 -> 128 findings, and 32 at
  -- the $100 floor, worth $27,362.18 in potentially doubled charges.
  routine as (
    select person, vendor, amount
      from ramp
     where vendor <> '(no payee)'
     group by 1, 2, 3
    having count(distinct txn_date) >= 3
  ),
  dup as (
    select 'duplicate'::text as kind,
           r.facility,
           min(r.posted_period)  as posted_period,
           r.txn_date,
           r.person, r.vendor,
           max(r.account_label)  as account_label,
           max(r.kpi_group)      as kpi_group,
           round(r.amount, 2)    as amount,
           count(*)::integer     as n,
           round(r.amount, 2)    as baseline,
           round(r.amount * (count(*) - 1), 2) as excess
      from ramp r
     where r.vendor <> '(no payee)'
       and r.amount >= 100
       and not exists (
             select 1 from routine ro
              where ro.person = r.person
                and ro.vendor = r.vendor
                and ro.amount = r.amount)
     group by r.facility, r.txn_date, r.person, r.vendor, r.amount
    having count(*) > 1
  ),

  all_alerts as (
    select kind, facility, posted_period, txn_date, person, vendor,
           account_label, kpi_group, amount, n, baseline, excess from large
    union all
    select kind, facility, posted_period, txn_date, person, vendor,
           account_label, kpi_group, amount, n, baseline, excess from spike
    union all
    select kind, facility, posted_period, txn_date, person, vendor,
           account_label, kpi_group, amount, n, baseline, excess from dup
  )

  -- One severity scale across all three rules, expressed in the only unit that
  -- means the same thing everywhere: how many dollars sit beyond the norm.
  select kind,
         case when excess >= 5000 then 'high' else 'medium' end as severity,
         facility, posted_period, txn_date, person, vendor,
         account_label, kpi_group, amount, n, baseline, excess
    from all_alerts
   order by excess desc, person, txn_date;
$$;

comment on function public.ramp_alerts() is
  'Out-of-the-norm Ramp charges: large charge, monthly spike, possible '
  'duplicate. Transaction grain, so service_role only -- reached through '
  '/api/alerts, never from the browser.';

revoke all on function public.ramp_alerts() from public, anon, authenticated;
grant execute on function public.ramp_alerts() to service_role;

-- ---------------------------------------------------------------------------
-- txn_totals() -- two new filters
-- ---------------------------------------------------------------------------
--
-- The Expense Intelligence page drills into "this person's Ramp charges", so the
-- exact count and sum must be filterable the same way. These MUST mirror
-- applyFilters() in lib/txnQuery.ts exactly: if they drift, the drawer's
-- reconciliation against the on-screen figure breaks silently, which is the one
-- failure mode this whole design exists to prevent.
--
-- DROP then CREATE, not `create or replace`: adding parameters produces an
-- OVERLOAD rather than a replacement, and two functions differing only in
-- default-able trailing arguments make every call ambiguous.
drop function if exists public.txn_totals(text, date, text, text, text, boolean, text);

create function public.txn_totals(
  p_facility      text    default null,
  p_posted_period date    default null,
  p_kpi_group     text    default null,
  p_account_label text    default null,
  p_vendor        text    default null,
  p_no_payee      boolean default false,
  p_q             text    default null,
  p_ramp          boolean default false,
  p_person        text    default null
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
     and (not p_ramp   or public.is_ramp_split(t.split))
     -- ramp_person() is the same function the aggregate is built from, so a
     -- person's drilled rows sum to their panel figure by construction.
     and (p_person is null or public.ramp_person(t.description) = p_person)
     and (p_q is null
          or t.name          ilike '%' || p_q || '%'
          or t.description   ilike '%' || p_q || '%'
          or t.account_label ilike '%' || p_q || '%');
$$;

revoke all on function public.txn_totals(text, date, text, text, text, boolean, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.txn_totals(text, date, text, text, text, boolean, text, boolean, text)
  to service_role;

-- NO EXPRESSION INDEX ON ramp_person(description), deliberately. It was written
-- and then removed: fact_txn is 29,864 rows and the existing aggregate over the
-- whole table runs in ~3ms, so the gain is noise -- while an index whose
-- expression is a user function silently CORRUPTS if that function is ever
-- redefined by `create or replace`, which is exactly how 0008 ships it. Bad
-- trade. Revisit when the table is large enough for the scan to show up in a
-- measurement rather than an intuition.
