-- 0018_fact_txn_row_key_width.sql
--
-- Refuse a row whose row_key is not a 64-bit hash.
--
-- WHY THIS IS NOT COSMETIC. row_key is `text`, and the identity is
-- (row_key, occurrence). The parser's hash was widened from 32-bit (8 hex
-- chars) to 64-bit (16) in the same change that rebuilt fact_txn. An 8-char key
-- can never collide with a 16-char one, so anything still producing the OLD key
-- would not be recognised as a duplicate by `on conflict do nothing` -- it would
-- APPEND a second copy of every row it uploads. Two realistic sources:
--
--   * a browser tab left open across the deploy, still running the previous
--     bundle, whose "Update data" upload posts old-style keys;
--   * an older checkout running scripts/backfill-fact-txn.mts.
--
-- Either doubles the warehouse. And rebuild_aggregates()'s five guards CANNOT
-- catch it: every one of them ties the aggregates to fact_txn, so a doubled
-- fact_txn produces doubled aggregates that agree with it perfectly and every
-- assertion passes. The dashboard would report ~$54.9M with no error anywhere.
-- The only place to catch this is at the row.
--
-- All 34,086 live rows already satisfy this (verified before applying), so the
-- constraint validates without a rewrite.
--
-- IF THE HASH IS EVER WIDENED AGAIN: this constraint must be updated in the same
-- migration that reloads the table, and that is the point -- it makes the
-- coupling between the parser and the stored keys explicit instead of implicit.

alter table public.fact_txn
  drop constraint if exists fact_txn_row_key_is_64bit;

alter table public.fact_txn
  add constraint fact_txn_row_key_is_64bit
  check (row_key ~ '^[0-9a-f]{16}$');

comment on constraint fact_txn_row_key_is_64bit on public.fact_txn is
  'row_key must be a 16-char lowercase hex FNV-1a-64 digest. Rejects rows from a '
  'client still emitting the old 32-bit key, which would append duplicates rather '
  'than conflict -- a doubling that every aggregate tie-out would happily confirm.';
