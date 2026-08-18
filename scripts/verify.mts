import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { ingestCsv } from "../lib/parse.ts";

// The source export is a financial extract and is gitignored (*.csv), so its
// location is not fixed. Resolve it from (in order): argv, $EXPENSE_CSV, then
// the first "Consolidated transaction detail" CSV in the repo or its parent.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findCsv(): string {
  const explicit = process.argv[2] || process.env.EXPENSE_CSV;
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`CSV not found at: ${explicit}`);
      process.exit(2);
    }
    return explicit;
  }
  for (const dir of [REPO, resolve(REPO, "..")]) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names
      .filter((f) => f.toLowerCase().endsWith(".csv") && /consolidated transaction detail/i.test(f))
      .sort();
    if (hit.length) return join(dir, hit[0]);
  }
  console.error(
    'Could not find a "Consolidated transaction detail" CSV.\n' +
      "Pass one explicitly:  npm run verify:parser -- /path/to/export.csv\n" +
      "or set EXPENSE_CSV=/path/to/export.csv",
  );
  process.exit(2);
}

const path = findCsv();
console.log("source           :", path);
const r = ingestCsv(readFileSync(path, "utf8"));

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
console.log("fact rows        :", r.factRows.length);
console.log("total            : $" + r.total.toFixed(2));
/* Keyed by total rather than by filename, because the same export gets renamed
   on the way out of QuickBooks. A file that parses to none of these has either
   changed upstream or hit a classification regression — both worth stopping for.

   19,709,887.26  original 14-facility scope
   22,851,611.16  + California Treatment Collective and Dallas Mental Health
   23,108,706.41  + Red Rock Behavioral Health, Apr 1 – Aug 18 2026 export */
const KNOWN_TOTALS: Record<string, string> = {
  "19709887.26": "original 14-facility scope",
  "22851611.16": "Apr 1 – Aug 11 2026 export (+ CTC, Dallas)",
  "23108706.41": "Apr 1 – Aug 18 2026 export (+ Red Rock)",
  "23088675.19": "Apr 1 – Aug 11 2026 backfill export, re-parsed with Red Rock mapped",
};
const known = KNOWN_TOTALS[r.total.toFixed(2)];
console.log("MATCH            :", known ? `YES ✅ — ${known}` : "NO ❌ — matches no known export");
console.log("aggGroupMonth    :", r.aggGroupMonth.length, "rows, sum $" + sum(r.aggGroupMonth.map((x) => x.amount)).toFixed(2));
console.log("aggAccount       :", r.aggAccount.length, "rows, sum $" + sum(r.aggAccount.map((x) => x.amount)).toFixed(2));
console.log("aggVendor        :", r.aggVendor.length, "rows");
console.log("months           :", r.monthsPresent.join(", "));
console.log("facilities        :", r.facilitiesPresent.length, "->", r.facilitiesPresent.join(", "));
console.log("max occurrence idx:", Math.max(...r.factRows.map((f) => f.occurrence)), "(0 = no identical repeats)");
// idempotency proof: re-run identity set must be stable
const keys = new Set(r.factRows.map((f) => f.row_key + ":" + f.occurrence));
console.log("unique (row_key,occurrence):", keys.size, "of", r.factRows.length, keys.size === r.factRows.length ? "✅ unique" : "❌ collision");
