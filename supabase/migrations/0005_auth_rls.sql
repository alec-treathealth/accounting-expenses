-- Move the dashboard's read tables off anon, and put access behind an explicit
-- invite list.
--
-- Two problems this closes:
--
-- 1. Every table below granted SELECT to anon with USING (true). The publishable
--    key ships inside the browser bundle, so anyone could read every aggregate
--    straight from PostgREST and never touch the app. A login screen in front of
--    the dashboard would not have changed that.
--
-- 2. Public signup is ENABLED on this project (verified by POSTing to
--    /auth/v1/signup with the publishable key: it returned 200 and created a
--    user). So "granted to authenticated" would have meant "granted to anyone
--    willing to register". Membership of app_access -- not merely holding a
--    session -- is therefore what grants access.
--
-- fact_txn is deliberately untouched: it already has RLS on with zero policies
-- and is reachable only through /api/txn using the service_role key. Because
-- service_role BYPASSES RLS, that route must check has_dashboard_access() in
-- application code -- policies alone cannot protect it.

-- --------------------------------------------------------------------------
-- The invite list
-- --------------------------------------------------------------------------

create table if not exists public.app_access (
  email      text primary key,
  note       text,
  granted_at timestamptz not null default now()
);

-- RLS on, zero policies: unreachable with the publishable key by any role.
-- has_dashboard_access() reads it as SECURITY DEFINER instead, so no client
-- ever needs to see the table -- not even to check its own membership.
alter table public.app_access enable row level security;

comment on table public.app_access is
  'Explicit dashboard invite list, keyed by email. A Supabase account alone '
  'grants nothing: public signup is open, so this table is the real gate. '
  'Add a row here AND create the user in Auth to give someone access.';

-- Seed with the accounts that already exist in auth.users.
insert into public.app_access (email, note) values
  ('alec@treathealth.ai',          'Owner'),
  ('gia@quickstarthealth.com',     'Initial invite'),
  ('lisaf@quickstarthealth.com',   'Initial invite')
on conflict (email) do nothing;

-- --------------------------------------------------------------------------
-- The gate
-- --------------------------------------------------------------------------

create or replace function public.has_dashboard_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.app_access a
     where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.has_dashboard_access() from public, anon;
grant execute on function public.has_dashboard_access() to authenticated;

-- --------------------------------------------------------------------------
-- Policies: authenticated AND on the invite list
-- --------------------------------------------------------------------------

drop policy if exists ro_agm on public.agg_group_month;
create policy ro_agm on public.agg_group_month
  for select to authenticated using (public.has_dashboard_access());

drop policy if exists ro_aa on public.agg_account;
create policy ro_aa on public.agg_account
  for select to authenticated using (public.has_dashboard_access());

drop policy if exists ro_av on public.agg_vendor;
create policy ro_av on public.agg_vendor
  for select to authenticated using (public.has_dashboard_access());

drop policy if exists ro_fac on public.dim_facility;
create policy ro_fac on public.dim_facility
  for select to authenticated using (public.has_dashboard_access());

drop policy if exists ro_map on public.map_account_group;
create policy ro_map on public.map_account_group
  for select to authenticated using (public.has_dashboard_access());

-- Belt and braces: PostgREST reaches these through the anon role, so drop the
-- table grant too. RLS alone would suffice today, but a future policy added
-- without a role clause would silently re-expose the data.
revoke select on public.agg_group_month, public.agg_account, public.agg_vendor,
                public.dim_facility, public.map_account_group
  from anon;

grant select on public.agg_group_month, public.agg_account, public.agg_vendor,
                public.dim_facility, public.map_account_group
  to authenticated;
