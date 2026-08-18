-- 0008_ramp_person.sql
--
-- Ramp card spend, attributed to the cardholder.
--
-- WHY THIS EXISTS
-- ---------------
-- 24,226 of fact_txn's 29,864 rows (81%) are Ramp card charges, worth
-- $4,154,179.85 of $22,851,611.16 (18%). Many rows, small dollars -- the exact
-- population a monthly close never inspects and a card-spend review is for. The
-- only carrier of "who" is fact_txn.description, which is transaction grain and
-- deliberately never reaches the browser, so a roll-up is needed.
--
-- WHAT THIS IS NOT
-- ----------------
-- Ramp is a SLICE of the existing eight KPI groups, not a ninth group. Every
-- dollar counted here is already counted in agg_group_month. Adding these
-- figures to the dashboard's total would report ~$27M against a true
-- $22,851,611.16. The UI labels the panel accordingly; this file only guarantees
-- that the slice ties to its source.

-- ---------------------------------------------------------------------------
-- The two definitions, fixed once
-- ---------------------------------------------------------------------------

-- A Ramp charge. Two spellings exist in the source and MUST fold together:
--   '2030 Ramp Card'         20,098 rows  $3,526,113.28  13 facilities
--   '2030 Ramp Credit Card'   4,128 rows    $628,066.57  Hillside only
-- Leaving them apart makes Hillside's $628K read as a separate card product.
--
-- POSTGRES TRAP, VERIFIED AGAINST THE LIVE TABLE: \b is BACKSPACE in a Postgres
-- regex, not a word boundary. `split ~* '^2030\s+ramp\b'` matches ZERO rows
-- where the expression below matches all 24,226. The word boundary is \y. The
-- POSIX character class is used instead of either, because it cannot be misread
-- by the next person to touch this file.
--
-- Anchored on 2030 on purpose: '2020 Capital One Xxxx6456' is a different card
-- and must stay out.
create or replace function public.is_ramp_split(p_split text)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(btrim(p_split) ~* '^2030[[:space:]]+ramp([[:space:]]|$)', false);
$$;

comment on function public.is_ramp_split(text) is
  'True when a fact_txn.split names the Ramp card liability account, folding '
  'both source spellings (2030 Ramp Card / 2030 Ramp Credit Card).';

-- The cardholder. description is either a bare name or "<name> - <memo>", so the
-- rule is: text before the first " - ", internal whitespace collapsed, trimmed.
--
-- Measured: 1,591 distinct raw descriptions collapse to 90 people. It merges
-- "Patrick O'Connell" (127 rows) with "Patrick O'Connell - Amazon order for
-- office supplies." (139 rows) and repairs "Joshua  luis" (double space).
--
-- Returns the literal '(unattributed)' rather than NULL for the 6 rows of 24,226
-- ($4,952.42) with no description: a NULL would drop out of every group by and
-- the panel would quietly stop summing to the Ramp total.
--
-- THIS IS THE SINGLE DEFINITION. The aggregate below, ramp_alerts() and the
-- /api/txn person filter all call it, so a figure on screen and the rows behind
-- it cannot drift apart.
create or replace function public.ramp_person(p_description text)
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(
           nullif(btrim(regexp_replace(split_part(coalesce(p_description, ''), ' - ', 1),
                                       '\s+', ' ', 'g')), ''),
           '(unattributed)');
$$;

comment on function public.ramp_person(text) is
  'Cardholder name from a Ramp charge description: text before the first " - ", '
  'whitespace collapsed. Never NULL -- unattributable rows return (unattributed).';

-- ---------------------------------------------------------------------------
-- Aggregates
-- ---------------------------------------------------------------------------

-- 1,493 rows against the current warehouse. Carrying kpi_group is what lets the
-- UI compare one person's spending mix with another's without a second read.
create table if not exists public.agg_ramp_person (
  facility      text          not null,
  posted_period date          not null,
  person        text          not null,
  kpi_group     text          not null,
  amount        numeric(14,2) not null,
  n             integer       not null,
  primary key (facility, posted_period, person, kpi_group)
);

-- Top 12 merchants per facility-and-person: 1,396 rows covering $3,715,544.89 of
-- $4,154,179.85 (89%), against 4,459 rows for the untruncated set. rk is kept so
-- the UI can prove the list is a top-N and print the covered share rather than
-- implying completeness.
create table if not exists public.agg_ramp_vendor (
  facility text          not null,
  person   text          not null,
  vendor   text          not null,
  amount   numeric(14,2) not null,
  n        integer       not null,
  rk       smallint      not null,
  primary key (facility, person, vendor)
);

comment on table public.agg_ramp_person is
  'Ramp card spend by cardholder, facility, month and KPI group. A SLICE of '
  'agg_group_month, never additive to it.';
comment on table public.agg_ramp_vendor is
  'Top 12 merchants per facility and cardholder on the Ramp card. Deliberately '
  'truncated -- rk exposes that so the UI cannot imply a complete list.';

alter table public.agg_ramp_person enable row level security;
alter table public.agg_ramp_vendor enable row level security;

-- Same gate as every other aggregate since 0005: a session is not enough, the
-- signed-in email must be on the app_access invite list.
drop policy if exists ro_arp on public.agg_ramp_person;
create policy ro_arp on public.agg_ramp_person
  for select to authenticated using (public.has_dashboard_access());

drop policy if exists ro_arv on public.agg_ramp_vendor;
create policy ro_arv on public.agg_ramp_vendor
  for select to authenticated using (public.has_dashboard_access());

-- Belt and braces, matching 0005: RLS alone would do today, but a future policy
-- written without a role clause would silently re-expose these to anon.
revoke select on public.agg_ramp_person, public.agg_ramp_vendor from anon;
grant  select on public.agg_ramp_person, public.agg_ramp_vendor to authenticated;

-- ---------------------------------------------------------------------------
-- rebuild_aggregates() -- 0003's body, plus the two Ramp tables and their guards
-- ---------------------------------------------------------------------------
--
-- Everything from 0003 is preserved verbatim: security definer, search_path, the
-- empty-fact_txn guard, the duplicate-account_label guard, the map-wins
-- resolution expression, and the three tie-out assertions. The additions are the
-- two inserts below and GUARD 4.
--
-- The Ramp tables tie to the RAMP SLICE of fact_txn, not to the whole table --
-- they are a filtered subset by design. Asserting them against the grand total
-- would fail every run and asserting nothing would let a bad filter go unnoticed.

create or replace function public.rebuild_aggregates()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact_amount numeric;
  v_fact_n      bigint;
  v_ramp_amount numeric;
  v_ramp_n      bigint;
  v_dup         text;
  v_amount      numeric;
  v_n           bigint;
begin
  -- GUARD 1: never rebuild from an empty fact table, so a failed or partial
  -- upload can never wipe the live aggregates.
  if (select count(*) from public.fact_txn) = 0 then
    return;
  end if;

  -- GUARD 2: the join below is only safe because account_label is unique in
  -- map_account_group. Fail loudly rather than quietly inflating the financials.
  select account_label into v_dup
    from public.map_account_group
   group by account_label having count(*) > 1
   limit 1;
  if v_dup is not null then
    raise exception
      'rebuild_aggregates: map_account_group has duplicate account_label %; refusing to rebuild (the join would double-count spend)', v_dup;
  end if;

  select sum(amount), count(*) into v_fact_amount, v_fact_n from public.fact_txn;
  select coalesce(sum(amount), 0), count(*) into v_ramp_amount, v_ramp_n
    from public.fact_txn where public.is_ramp_split(split);

  -- Surface brand-new account labels in the taxonomy so they can be reviewed in
  -- the admin UI instead of being invisible. Insert-only, never overwriting a
  -- human's decision.
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

  -- Ramp by cardholder. Same map-wins group resolution as every other aggregate,
  -- so a taxonomy edit moves a person's spend between groups exactly as it moves
  -- the dashboard's.
  delete from public.agg_ramp_person;
  insert into public.agg_ramp_person (facility, posted_period, person, kpi_group, amount, n)
    select f.facility,
           f.posted_period,
           public.ramp_person(f.description),
           coalesce(nullif(btrim(m.kpi_group), ''), nullif(btrim(f.kpi_group), ''), 'Unclassified expense'),
           round(sum(f.amount), 2),
           count(*)
      from public.fact_txn f
      left join public.map_account_group m on m.account_label = f.account_label
     where public.is_ramp_split(f.split)
     group by 1, 2, 3, 4;

  -- Top 12 merchants per facility and cardholder. Ordered by amount desc with
  -- vendor as the tiebreak so the cut is deterministic: without it, two merchants
  -- at the same amount could swap across rebuilds and rk would be unstable.
  delete from public.agg_ramp_vendor;
  insert into public.agg_ramp_vendor (facility, person, vendor, amount, n, rk)
    select facility, person, vendor, amount, n, rk
      from (
        select f.facility,
               public.ramp_person(f.description)                   as person,
               coalesce(nullif(btrim(f.name), ''), '(no payee)')   as vendor,
               round(sum(f.amount), 2)                             as amount,
               count(*)::integer                                   as n,
               row_number() over (
                 partition by f.facility, public.ramp_person(f.description)
                 order by sum(f.amount) desc,
                          coalesce(nullif(btrim(f.name), ''), '(no payee)')
               )::smallint                                         as rk
          from public.fact_txn f
         where public.is_ramp_split(f.split)
         group by 1, 2, 3
      ) ranked
     where rk <= 12;

  -- GUARD 3: re-grouping must be value-preserving. Every fact row lands in
  -- exactly one bucket of each aggregate, so money and row count both have to tie
  -- back to fact_txn exactly. Raising here rolls the whole rebuild back.
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

  -- GUARD 4 (new): agg_ramp_person must tie to the RAMP SLICE exactly. This is
  -- what makes "who spent it" trustworthy -- if is_ramp_split() or ramp_person()
  -- ever drops or duplicates a row, the numbers on the Expense Intelligence page
  -- would be quietly wrong, which is worse than a failed rebuild.
  select coalesce(sum(amount), 0), coalesce(sum(n), 0) into v_amount, v_n
    from public.agg_ramp_person;
  if v_amount <> v_ramp_amount or v_n <> v_ramp_n then
    raise exception 'rebuild_aggregates: agg_ramp_person does not tie to the Ramp slice of fact_txn (% / % rows vs % / % rows)',
      v_amount, v_n, v_ramp_amount, v_ramp_n;
  end if;

  -- agg_ramp_vendor is truncated to the top 12, so it CANNOT tie to the slice.
  -- What must hold is that it never claims MORE than the slice -- a top-N that
  -- exceeds its parent means the ranking window double-counted.
  select coalesce(sum(amount), 0), coalesce(sum(n), 0) into v_amount, v_n
    from public.agg_ramp_vendor;
  if v_amount > v_ramp_amount or v_n > v_ramp_n then
    raise exception 'rebuild_aggregates: agg_ramp_vendor (% / % rows) exceeds the Ramp slice (% / % rows)',
      v_amount, v_n, v_ramp_amount, v_ramp_n;
  end if;
end;
$$;

-- Carried over from 0001/0003: the rebuild is service_role-only, reached
-- exclusively through the server routes /api/ingest and /api/mapping. The PUBLIC
-- grant that anon/authenticated inherit is revoked in 0004; `create or replace`
-- preserves the existing ACL, so this file stays order-independent.
revoke all on function public.rebuild_aggregates() from anon, authenticated;
