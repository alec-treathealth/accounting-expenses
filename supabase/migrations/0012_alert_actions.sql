-- 0012_alert_actions.sql
--
-- Read state and a shared investigation list for the alerts feed.
--
-- 0009 shipped alerts with no durable state, on purpose: "dismissal is real
-- state and a real feature, and it is not in scope". It is now in scope, so this
-- is that feature — built as state rather than as a button that forgets on
-- reload, which would have been a lie about what the system remembers.
--
-- TWO TABLES, BECAUSE TWO DIFFERENT THINGS
-- ----------------------------------------
-- Read state is PERSONAL: it drives one person's notification badge, and the
-- bookkeeper clearing their badge must not clear the controller's. It is keyed
-- by email.
--
-- The investigation list is SHARED: the entire point of flagging a charge is
-- that the team sees it. It is keyed by the charge alone, and records who
-- pinned it so the list is attributable. Anyone can unpin — a worklist only one
-- person can clear is a worklist that stops being cleared.
--
-- Collapsing these into one table with a `kind` column would have forced one
-- primary key onto both semantics and made one of them wrong.
--
-- BOTH ARE SERVER-ONLY: RLS on, zero policies, reachable exclusively through
-- /api/alerts with the service_role key. alert_pin stores a snapshot of the
-- charge, which is transaction grain — a named person, a date, a merchant, an
-- amount — the same class of data as fact_txn, and it stays behind the same
-- single door.

-- ---------------------------------------------------------------------------
-- A stable identity for a computed finding
-- ---------------------------------------------------------------------------
--
-- Alerts are derived, never stored, so state has to hang off something that
-- survives a re-ingest. The key is a digest of what MAKES the finding: rule,
-- facility, cardholder, date, merchant and amount. Deliberately NOT the
-- duplicate count `n` — a third identical charge appearing is the same finding
-- with a worse number, and marking it read should not silently un-read it.
--
-- md5 is used as a content digest, not as a security primitive. It is never
-- checked against an attacker-supplied value: /api/alerts recomputes the feed
-- and accepts a key only if the server itself just produced it.

-- DROP first, not `create or replace`: adding alert_key changes the row type the
-- OUT parameters define, and Postgres refuses to replace a set-returning
-- function whose shape has changed ("cannot change return type of existing
-- function"). Nothing depends on it but /api/alerts, which redeploys with this.
drop function if exists public.ramp_alerts();

create function public.ramp_alerts()
returns table (
  alert_key text, kind text, severity text, facility text, posted_period date,
  txn_date date, person text, vendor text, account_label text, kpi_group text,
  amount numeric, n integer, baseline numeric, excess numeric
)
language sql stable security definer set search_path = public as $$
  with ramp as (
    select f.facility, f.posted_period, f.txn_date,
           public.ramp_person(f.description) as person,
           coalesce(nullif(btrim(f.name), ''), '(no payee)') as vendor,
           f.account_label,
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense') as kpi_group,
           f.amount
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     where public.is_ramp_split(f.split)
       -- Credits and refunds are not overspending. 196 rows are negative.
       and f.amount > 0
  ),
  -- Median, not mean: one $18,628 charge would drag a mean high enough to hide
  -- the next one. The ::numeric cast is REQUIRED — Postgres ships no numeric
  -- variant of percentile_cont, so the result comes back float8 and round(m,2)
  -- would fail to resolve.
  med as (
    select person, (percentile_cont(0.5) within group (order by amount))::numeric as m,
           count(*) as n
      from ramp group by person
  ),
  -- RULE 1 -- large charge: >= 10x the person's median AND >= $2,500, only for
  -- people with >= 12 charges (a median over three rows is not a norm).
  --
  -- GROUPED, not one row per charge. Three identical $7,737.45 charges to
  -- "shed" on 2026-05-13 produced three findings a reader could not tell
  -- apart — and, worse, three findings sharing ONE alert_key, so marking one
  -- read would have silently marked all three and pinning one would have
  -- pinned all three. n carries the count, excess covers all of them, and the
  -- duplicate rule still reports the repetition separately, which is where
  -- "these arrived three times" actually belongs.
  large as (
    select 'large_charge'::text as kind, r.facility, r.posted_period, r.txn_date,
           r.person, r.vendor, r.account_label, r.kpi_group,
           round(r.amount, 2) as amount, count(*)::integer as n,
           round(med.m, 2) as baseline,
           round(count(*) * (r.amount - med.m), 2) as excess
      from ramp r join med on med.person = r.person
     where med.n >= 12 and r.amount >= greatest(10 * med.m, 2500)
     group by r.facility, r.posted_period, r.txn_date, r.person, r.vendor,
              r.account_label, r.kpi_group, r.amount, med.m
  ),
  -- RULE 2 -- monthly spike, per (facility, person) so every alert carries the
  -- facility the page filters on.
  pm as (
    select facility, person, posted_period, sum(amount) as amt, count(*)::integer as n
      from ramp group by 1, 2, 3
  ),
  spike as (
    select 'monthly_spike'::text as kind, facility, posted_period,
           null::date as txn_date, person,
           null::text as vendor, null::text as account_label, null::text as kpi_group,
           round(amt, 2) as amount, n,
           round(prior_avg, 2) as baseline, round(amt - prior_avg, 2) as excess
      from (
        select facility, person, posted_period, amt, n,
               avg(amt) over w as prior_avg, count(*) over w as prior_months
          from pm
        window w as (partition by facility, person order by posted_period
                     rows between unbounded preceding and 1 preceding)
      ) s
     where prior_months >= 2 and prior_avg > 0
       and amt >= 2 * prior_avg and amt - prior_avg >= 1000
  ),
  -- RULE 3 -- possible duplicate.
  -- THE ROUTINE-RECURRENCE EXCLUSION IS LOAD-BEARING. Without it the rule fires
  -- 446 times at >= $250, and 414 of those are 'Google Ads' at exactly $500.00
  -- against '6010 PPC- Pay Per Click' -- an ad-platform daily budget cap charged
  -- repeatedly BY DESIGN. A (person, vendor, amount) triple seen on 3+ DISTINCT
  -- DAYS is recurring by definition and can never raise a duplicate.
  routine as (
    select person, vendor, amount from ramp
     where vendor <> '(no payee)'
     group by 1, 2, 3 having count(distinct txn_date) >= 3
  ),
  dup as (
    select 'duplicate'::text as kind, r.facility, min(r.posted_period) as posted_period,
           r.txn_date, r.person, r.vendor,
           max(r.account_label) as account_label, max(r.kpi_group) as kpi_group,
           round(r.amount, 2) as amount, count(*)::integer as n,
           round(r.amount, 2) as baseline,
           round(r.amount * (count(*) - 1), 2) as excess
      from ramp r
     where r.vendor <> '(no payee)' and r.amount >= 100
       and not exists (select 1 from routine ro
                        where ro.person = r.person and ro.vendor = r.vendor and ro.amount = r.amount)
     group by r.facility, r.txn_date, r.person, r.vendor, r.amount
    having count(*) > 1
  ),
  all_alerts as (
    select kind, facility, posted_period, txn_date, person, vendor, account_label, kpi_group, amount, n, baseline, excess from large
    union all
    select kind, facility, posted_period, txn_date, person, vendor, account_label, kpi_group, amount, n, baseline, excess from spike
    union all
    select kind, facility, posted_period, txn_date, person, vendor, account_label, kpi_group, amount, n, baseline, excess from dup
  )
  select md5(kind || '|' || facility || '|' || person || '|' ||
             coalesce(txn_date::text, posted_period::text) || '|' ||
             coalesce(vendor, '') || '|' || amount::text) as alert_key,
         kind,
         -- One severity scale across all three rules, in the only unit that
         -- means the same thing everywhere: dollars beyond the norm.
         case when excess >= 5000 then 'high' else 'medium' end as severity,
         facility, posted_period, txn_date, person, vendor, account_label, kpi_group,
         amount, n, baseline, excess
    from all_alerts
   order by excess desc, person, txn_date;
$$;

comment on function public.ramp_alerts() is
  'Out-of-the-norm Ramp charges with a stable alert_key. Transaction grain, so service_role only.';

revoke all on function public.ramp_alerts() from public, anon, authenticated;
grant execute on function public.ramp_alerts() to service_role;

-- ---------------------------------------------------------------------------
-- Personal read state
-- ---------------------------------------------------------------------------

create table if not exists public.alert_read (
  email     text        not null,
  alert_key text        not null,
  at        timestamptz not null default now(),
  primary key (email, alert_key)
);

comment on table public.alert_read is
  'Which alerts a given signed-in user has marked read. Personal: it drives '
  'that user''s badge only. Keyed by email to match public.app_access.';

alter table public.alert_read enable row level security;
revoke all on public.alert_read from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The shared investigation list
-- ---------------------------------------------------------------------------
--
-- The snapshot columns are not denormalisation for speed. An alert is derived
-- from fact_txn, so a re-ingest that corrects or removes the underlying charge
-- would make a key-only row point at nothing — and a pinned item that silently
-- becomes blank is worse than one that says what it used to be. The list shows
-- the snapshot and flags anything the current feed no longer contains.

create table if not exists public.alert_pin (
  alert_key     text primary key,
  pinned_by     text        not null,
  pinned_at     timestamptz not null default now(),
  note          text,
  kind          text        not null,
  severity      text        not null,
  facility      text        not null,
  posted_period date        not null,
  txn_date      date,
  person        text        not null,
  vendor        text,
  account_label text,
  kpi_group     text,
  amount        numeric(14,2) not null,
  n             integer     not null,
  baseline      numeric(14,2),
  excess        numeric(14,2) not null
);

comment on table public.alert_pin is
  'Charges flagged for investigation. SHARED across the team and attributable '
  'to whoever pinned it; anyone may unpin. Carries a snapshot so an item '
  'survives the underlying charge changing.';

alter table public.alert_pin enable row level security;
revoke all on public.alert_pin from anon, authenticated;

create index if not exists alert_pin_pinned_at_idx on public.alert_pin (pinned_at desc);
