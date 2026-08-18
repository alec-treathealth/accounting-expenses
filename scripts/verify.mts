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

   EVERY EARLIER FIGURE HERE WAS WRONG, and not by a little. 19,709,887.26 /
   22,851,611.16 / 23,108,706.41 / 23,088,675.19 were all produced by the parser
   that decided company-vs-account by "does the name start with a digit", which
   silently dropped every account section following an account whose name does
   not — and every row after it in that company. They are artefacts of a defect,
   not historical states of the business, so they are not kept as history.

   The section-stack parser ties each of these to the report's own printed
   "Total for" subtotals across all 1,756 / 2,008 sections with zero mismatches. */
const KNOWN_TOTALS: Record<string, string> = {
  "27358347.38": "Apr 1 – Aug 18 2026 export",
  "27308353.19": "Apr 1 – Aug 11 2026 backfill export",
};
const known = KNOWN_TOTALS[r.total.toFixed(2)];
console.log("MATCH            :", known ? `YES ✅ — ${known}` : "NO ❌ — matches no known export");
console.log("aggGroupMonth    :", r.aggGroupMonth.length, "rows, sum $" + sum(r.aggGroupMonth.map((x) => x.amount)).toFixed(2));
console.log("aggAccount       :", r.aggAccount.length, "rows, sum $" + sum(r.aggAccount.map((x) => x.amount)).toFixed(2));
console.log("aggVendor        :", r.aggVendor.length, "rows");
console.log("months           :", r.monthsPresent.join(", "));
console.log("facilities        :", r.facilitiesPresent.length, "->", r.facilitiesPresent.join(", "));
/* Structural anomalies are the whole point of the section-stack parser: a file
   that parses to a plausible total while being mis-nested is the failure this
   script exists to catch. Printing them is not enough -- a non-zero exit is what
   makes CI and a human notice. */
if (r.anomalies.length) {
  console.log("\nSTRUCTURAL ANOMALIES (this file must NOT be ingested):");
  for (const a of r.anomalies) console.log("  ! " + a);
  process.exit(1);
}
console.log("anomalies        : none");
console.log("max occurrence idx:", Math.max(...r.factRows.map((f) => f.occurrence)), "(0 = no identical repeats)");
// idempotency proof: re-run identity set must be stable
const keys = new Set(r.factRows.map((f) => f.row_key + ":" + f.occurrence));
console.log("unique (row_key,occurrence):", keys.size, "of", r.factRows.length, keys.size === r.factRows.length ? "✅ unique" : "❌ collision");
