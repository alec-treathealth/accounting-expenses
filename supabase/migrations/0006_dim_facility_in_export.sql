-- Records whether a facility APPEARED in the source consolidated export, which
-- is a different question from whether it spent anything.
--
-- Nashville Mental Health files 913 transactions in the Apr 1 - Aug 11 2026
-- export, but every one lands in a balance-sheet account (1010 bank, 1100 A/R,
-- 1200 payments to deposit, 1500 vehicles, 2000 A/P). classify() correctly keeps
-- only expense/COGS accounts, so Nashville contributes no rows to fact_txn and
-- never appears in agg_group_month -- yet it plainly reported. Deriving
-- "facilities reporting" from the aggregates therefore undercounted it as 15
-- when the honest figure is 16.
--
-- Mental Health Center of San Diego is the only in-scope facility genuinely
-- absent from the export: none of the 77 entity headers in the file match it.
alter table public.dim_facility
  add column if not exists in_export boolean not null default true;

update public.dim_facility
   set in_export = false
 where facility = 'Mental Health Center of San Diego';

comment on column public.dim_facility.in_export is
  'True when this facility appears as an entity section in the source export, even if it booked no expense (e.g. Nashville MH). False only when genuinely absent from the file.';
