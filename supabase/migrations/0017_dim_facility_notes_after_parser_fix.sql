-- 0017_dim_facility_notes_after_parser_fix.sql
--
-- Two dim_facility notes are now false and one is missing. Notes are read by
-- humans deciding whether a number is trustworthy, so a note that rationalises a
-- bug is worse than no note at all.
--
-- NASHVILLE MH. Its note read:
--   "No operating-expense accounts in this export (bank/AR/vehicles only);
--    costs booked under another entity."
-- Every clause is wrong. Nashville files 59 account sections including 20+
-- expense accounts, and books 3,304 in-scope rows worth $2,928,698.55. What
-- actually happened is a PARSER defect: ingestCsv decided company-vs-account by
-- "does the name start with a digit", and Nashville's chart of accounts contains
-- "DON'T USE! Due To R&B Mgmt (deleted)". That was read as a new company, so the
-- 6,381 rows in every account after it -- 2030 Ramp Card and the whole expense
-- range -- were attributed to a company not in FACILITY and dropped. Only the
-- 941 rows in 1010/1100/1200/1500/2000, which precede it, survived, and those
-- are all balance-sheet accounts. Hence "bank/AR/vehicles only": that was the
-- SYMPTOM being read as the cause.
--
-- This note supersedes the Nashville claims in 0006_dim_facility_in_export.sql
-- and 0014_dim_facility_beds.sql. Those files are NOT edited: they are applied
-- history in a hand-applied repo, and rewriting them would erase the fact that
-- the dashboard once believed this. in_export stays true (it was, and is,
-- present) and beds stays 20.
--
-- ST. LOUIS MENTAL HEALTH is the opposite case and needs the note it never had:
-- its rows are real but FROZEN. It has no section at all in the Aug 18 export --
-- it appears there only as "St Louis Mental Health, LLC (IC Customer)" on other
-- entities' invoices -- so it was deconsolidated or dropped from the export
-- filter, not renamed. Its 30 rows were deliberately carried forward from the
-- Aug 11 backfill and will not refresh until it reappears in an export.

update public.dim_facility
   set note = 'Reported $0 until 2026-08-18 because of a PARSER defect, not an accounting '
              'fact: the account "DON''T USE! Due To R&B Mgmt (deleted)" was misread as a '
              'company header, so the 6,381 rows in every account after it were dropped. '
              'Files 59 account sections; books 3,304 in-scope rows / $2,928,698.55. '
              'Supersedes the Nashville note in 0006.'
 where facility = 'Nashville MH';

update public.dim_facility
   set note = 'CARRIED FORWARD AND FROZEN at 2026-08-11. Absent as an entity section from '
              'the Aug 18 2026 export (present only as "St Louis Mental Health, LLC '
              '(IC Customer)" on other entities'' invoices), so it appears to have been '
              'deconsolidated rather than renamed. Its 30 rows / $98,662.71 were loaded '
              'from the previous export by deliberate decision and will not refresh until '
              'it reappears in an export. Treat as stale, not current.'
 where facility = 'St. Louis Mental Health';
