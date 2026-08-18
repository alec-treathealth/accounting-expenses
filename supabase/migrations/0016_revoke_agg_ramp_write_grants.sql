-- 0016_revoke_agg_ramp_write_grants.sql
--
-- agg_ramp_person, agg_ramp_vendor and app_access carry table-level write
-- grants that no other table in this schema has:
--
--   agg_ramp_person   anon           DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE
--   agg_ramp_person   authenticated  the same, plus SELECT
--   agg_ramp_vendor   anon           DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE
--   agg_ramp_vendor   authenticated  the same, plus SELECT
--   app_access        anon           DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--   app_access        authenticated  the same
--
-- while agg_group_month, agg_account, agg_vendor and dim_facility grant
-- `authenticated` SELECT and nothing else. The Ramp tables were created in 0008
-- without the REVOKE that the older tables received, so they kept the default
-- PUBLIC grants.
--
-- NOT CURRENTLY EXPLOITABLE, and this file does not pretend otherwise. All three
-- have RLS enabled with no write policy at all (agg_ramp_person/agg_ramp_vendor
-- have exactly one SELECT policy for `authenticated`; app_access has none), so
-- RLS refuses these writes regardless of the grant. This is defence in depth:
-- the grant is the thing that would become live the moment anyone adds a
-- permissive policy, and app_access is the invite list that gates the whole
-- dashboard, so an INSERT there is a privilege escalation waiting for a policy.
--
-- Aggregates are derived data. NOTHING should write them but rebuild_aggregates(),
-- which is SECURITY DEFINER and already revoked from anon/authenticated by 0004.

revoke all on public.agg_ramp_person from anon, authenticated;
revoke all on public.agg_ramp_vendor from anon, authenticated;
revoke all on public.app_access     from anon, authenticated;

-- Restore only what the dashboard actually reads. app_access is deliberately
-- given nothing: it is read server-side with the service role.
grant select on public.agg_ramp_person to authenticated;
grant select on public.agg_ramp_vendor to authenticated;

notify pgrst, 'reload schema';
