// An INDEPENDENT TypeScript restatement of the two Ramp definitions that live in
// SQL (public.is_ramp_split / public.ramp_person, supabase/migrations/0008).
//
// WHY A SECOND IMPLEMENTATION IS NOT A SECOND SOURCE OF TRUTH
// -----------------------------------------------------------
// The application NEVER derives a cardholder in TypeScript — it reads
// agg_ramp_person, which the database built. This file exists only so the checks
// can assert that the SQL does what the spec says, from the other side. A mirror
// that agrees with the original is evidence; a mirror the app depends on would
// be a liability. Nothing under app/, components/ or lib/ may import this.
//
// It is also what lets the offline fixture in txn-drilldown.mts stand in for the
// PostgREST computed columns is_ramp and ramp_cardholder.

/** Mirrors: btrim(split) ~* '^2030[[:space:]]+ramp([[:space:]]|$)'
 *
 *  Note \s in JavaScript is a genuine whitespace class, unlike Postgres where
 *  \b means BACKSPACE — the trap that made the first version of the SQL match
 *  zero rows. The POSIX class in SQL and this regex describe the same set. */
export function isRampSplit(split: string | null | undefined): boolean {
  if (!split) return false;
  return /^2030\s+ramp(\s|$)/i.test(split.trim());
}

/** Mirrors: coalesce(nullif(btrim(regexp_replace(split_part(description,' - ',1),'\s+',' ','g')),''), '(unattributed)') */
export function rampPerson(description: string | null | undefined): string {
  const head = (description ?? "").split(" - ")[0];
  const collapsed = head.replace(/\s+/g, " ").trim();
  return collapsed === "" ? "(unattributed)" : collapsed;
}
