-- 0013_dim_facility_red_rock.sql
--
-- Red Rock Behavioral Health enters scope.
--
-- It files its own entity section in the Apr 1 - Aug 18 2026 consolidated
-- export -- 351 rows, of which 152 land in operating-expense and COGS accounts
-- worth $246,064.03 across all five months (5060 Client Supplies, 6330 Repairs &
-- Maintenance, 6170 Utilities, 6280 IT Expense, 6190 Rent and 19 more).
--
-- THIS WAS NEVER AN EXPORT GAP, IT WAS A MAPPING GAP. The PREVIOUS export
-- carried Red Rock too -- 151 classified rows worth $237,064.03 over the same
-- Apr 1 - Aug 11 window -- and every one of them was parsed and then dropped,
-- because lib/classify.ts FACILITY had no entry and ingestCsv() skips any
-- transaction whose entity it cannot name. A facility can therefore be missing
-- from the dashboard while being fully present in the source, and nothing in
-- the reconciliation notices: the totals tie because the dropped rows are
-- absent from both sides.
--
-- dim_facility is the ROSTER; lib/classify.ts FACILITY is what actually admits
-- rows to fact_txn. Both are needed, and entity_raw must equal the FACILITY key
-- exactly or the roster and the data disagree about what the facility is called.
-- Here the raw entity string and the canonical name are identical, so there is
-- no alias to get wrong -- unlike e.g. 'Kentucky Wellness Center' ->
-- 'Kentucky Mental Health'.
--
-- in_export is true because it genuinely appears as an entity section, which is
-- the question that column answers (see 0006).

insert into public.dim_facility (facility, entity_raw, in_scope, in_export, note)
values (
  'Red Rock Behavioral Health',
  'Red Rock Behavioral Health',
  true,
  true,
  'Added to scope 2026-08-18: present in the Apr 1 - Aug 18 2026 consolidated export '
  'as its own entity section with operating-expense and COGS accounts '
  '(152 classified rows, $246,064.03). Also present in the previous export '
  '(151 rows, $237,064.03) but dropped at parse time for want of a '
  'lib/classify.ts FACILITY entry -- a mapping gap, not an export gap.'
)
on conflict (facility) do nothing;
