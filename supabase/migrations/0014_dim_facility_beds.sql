-- 0014_dim_facility_beds.sql
--
-- Licensed bed capacity per facility, so "Cost per Bed" divides by a number the
-- warehouse owns rather than a map hardcoded in a React component that drifts
-- the first time a facility is relicensed.
--
-- Follows 0002 and 0006: dim_facility gains a column rather than a side table.
-- It is one scalar attribute per facility, with the same lifetime as the row it
-- hangs off, and every reader already selects * from dim_facility.
--
-- NULLABLE ON PURPOSE, AND THE NULL MEANS SOMETHING. A facility with spend and
-- no bed count must render "no bed count on file" -- never $0, never a silently
-- dropped row. Defaulting to 0 would be worse than useless: it divides to
-- Infinity, and a NOT NULL default would make "we have not been told" and "it
-- has no beds" indistinguishable.
--
-- The check constraint enforces that: a bed count is either absent or positive,
-- never zero, so no reader has to guard a division.
--
-- CALIFORNIA TREATMENT COLLECTIVE IS DELIBERATELY LEFT NULL. It is excluded
-- from the Cost per Bed KPI and from nothing else -- its $1,752,707.88 stays in
-- fact_txn, in agg_group_month and in every org-wide total, and it remains
-- in_scope. Do not "complete" this table by inventing a capacity for it.
--
-- Mental Health Center of San Diego is likewise left NULL: it is absent from the
-- export (in_export = false) and has no capacity on file.
--
-- Nashville MH has 20 beds and zero expense rows -- its costs are booked under
-- another entity (see 0006). It is reported as beds-without-spend rather than
-- being counted as a facility that spent nothing.

alter table public.dim_facility
  add column if not exists beds integer;

alter table public.dim_facility
  drop constraint if exists dim_facility_beds_positive;
alter table public.dim_facility
  add constraint dim_facility_beds_positive check (beds is null or beds > 0);

update public.dim_facility d
   set beds = v.beds
  from (values
    ('California MH',                     12),
    ('Dallas Mental Health',              12),
    ('Hillside',                          18),
    ('Houston Mental Health',             14),
    ('Kentucky Mental Health',            16),
    ('Lonestar',                          12),
    ('Los Angeles MH',                     6),
    ('Nashville MH',                      20),
    ('Northern California Mental Health',  6),
    ('Opus Health',                       12),
    ('Pacific MH',                         6),
    ('Red Rock Behavioral Health',        10),
    ('Revival MH',                        12),
    ('Silicon Valley Recovery',           16),
    ('St. Louis Mental Health',           14),
    ('Tennessee Behavioral',               8)
  ) as v(facility, beds)
 where d.facility = v.facility;

comment on column public.dim_facility.beds is
  'Licensed bed capacity. NULL means no bed count is on file -- readers must '
  'disclose that facility rather than treat it as zero. Capacity only: there is '
  'no census or occupancy data in this database, so anything derived from this '
  'column is per BED, never per client.';

notify pgrst, 'reload schema';
