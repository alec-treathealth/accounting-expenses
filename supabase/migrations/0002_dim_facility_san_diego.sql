-- "Mental Health Center of San Diego" is the 15th facility on the RES list but
-- does not appear in the Apr 1 - Aug 11 2026 consolidated export: none of the 77
-- entity section headers in that file matches it under any spelling, so the
-- parser has no entity to map it from and it carried no row at all.
--
-- Recording it here (rather than leaving it out) keeps the roster honest: the
-- dashboard now reports "13 of 15" and names the two facilities with no spend,
-- instead of a hardcoded "of 14" that silently dropped one. No amounts are
-- attributed to it, so the report still reconciles to $19,709,887.26.

insert into public.dim_facility (facility, entity_raw, in_scope, note)
values (
  'Mental Health Center of San Diego',
  'Mental Health Center of San Diego',
  true,
  'In the RES facility list but absent from this export: no entity header matches it in the Apr 1 - Aug 11 2026 consolidated report (77 entities checked). Treated as no expense activity for the period; no spend is attributed to it.'
)
on conflict (facility) do update
  set note = excluded.note,
      in_scope = excluded.in_scope;
