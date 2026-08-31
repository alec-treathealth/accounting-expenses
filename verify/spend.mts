// Proves the two spend cards and Cost per Bed against the LIVE warehouse.
//
// Three claims are being made on screen and each is checked here:
//
//   1. "COGS + Expenses" and "Operating Expenses" are DIFFERENT numbers that
//      still add up — the split is real, not one figure under two labels;
//   2. splitting on kpi_group agrees with map_account_group.kind, which is the
//      assumption lib/spend.ts documents and the only one that can rot (an
//      /admin re-map can change a group but never a kind);
//   3. Cost per Bed divides spend by capacity for THE SAME facilities, and
//      every facility it leaves out is one of the two disclosed states.
//
// Read-only.
//
//   npm run verify:spend

import { restAll, cents, money } from "./supabase.mts";
import { ADVERTISING_GROUP, COGS_GROUP, PER_BED_EXCLUDED, costPerBed, splitSpend, type BedCount, type FacilitySpendRow } from "../lib/spend.ts";

let failures = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

const gm = await restAll<any>("agg_group_month?select=facility,posted_period,kpi_group,amount,n&order=facility.asc,posted_period.asc,kpi_group.asc");
const rows: FacilitySpendRow[] = gm.map((r) => ({
  facility: String(r.facility),
  kpi_group: String(r.kpi_group),
  amount: Number(r.amount),
  n: Number(r.n),
}));
const dim = await restAll<any>("dim_facility?select=facility,beds,in_scope&order=facility.asc");
const beds: BedCount[] = dim.map((d) => ({
  facility: String(d.facility),
  beds: d.beds == null ? null : Number(d.beds),
}));

// --- 1. the split is real ---------------------------------------------------

console.log("== the two spend cards ==");
const split = splitSpend(rows);
console.log(`COGS + Expenses  : ${money(cents(split.all))}`);
console.log(`Operating Expenses: ${money(cents(split.operating))}`);
console.log(`Cost of Goods Sold: ${money(cents(split.cogs))}`);

ok(cents(split.cogs) + cents(split.operating) === cents(split.all),
   "the two cards add up to the total", `${money(cents(split.operating))} + ${money(cents(split.cogs))} = ${money(cents(split.all))}`);
ok(cents(split.operating) !== cents(split.all),
   "the two cards are genuinely different numbers, not one figure twice");
ok(cents(split.cogs) > 0, "there is COGS to separate out", money(cents(split.cogs)));

const factRows = await restAll<any>("fact_txn?select=amount&order=row_key.asc,occurrence.asc");
const factCents = factRows.reduce((s, r) => s + cents(r.amount), 0);
ok(cents(split.all) === factCents, "COGS + Expenses still ties to fact_txn to the penny",
   `${money(cents(split.all))} vs ${money(factCents)}`);

// --- 2. kpi_group and kind still agree --------------------------------------
// lib/spend.ts splits on the GROUP because agg_group_month is the only aggregate
// with a facility and a month. This asserts that choice still matches `kind`.

console.log("\n== kpi_group vs map_account_group.kind ==");
const map = await restAll<any>("map_account_group?select=account_label,kpi_group,kind&order=account_label.asc");
const disagree = map.filter(
  (m) => (String(m.kind) === "COGS") !== (String(m.kpi_group) === COGS_GROUP),
);
ok(disagree.length === 0,
   `every kind='COGS' account is in '${COGS_GROUP}' and vice versa`,
   disagree.length
     ? `${disagree.length} disagree, first: ${disagree[0].account_label} (kind=${disagree[0].kind}, group=${disagree[0].kpi_group})`
     : `${map.length} accounts`);

// --- 3. cost per bed --------------------------------------------------------

console.log("\n== cost per bed ==");
const cpb = costPerBed(rows, beds);
console.log(`numerator  : ${money(cents(cpb.amount))} over ${cpb.counted.length} facilities`);
console.log(`denominator: ${cpb.beds} licensed beds`);
console.log(`cost per bed: ${cpb.perBed === null ? "—" : money(cents(cpb.perBed))}`);

ok(cpb.perBed !== null, "there is a cost per bed to report");
ok(cpb.beds > 0, "the denominator is a real bed count", `${cpb.beds} beds`);
ok(Math.abs((cpb.perBed ?? 0) * cpb.beds - cpb.amount) < 1,
   "cost per bed times beds returns the numerator", `${money(cents((cpb.perBed ?? 0) * cpb.beds))} vs ${money(cents(cpb.amount))}`);

/* ELIGIBLE spend — the numerator's own definition (operating expense less
   marketing), not total spend. Using total here would report a facility whose
   only activity is COGS or marketing as "silently dropped" when it is in fact
   correctly disclosed as having nothing this ratio counts. */
const eligible = rows.filter((r) => !PER_BED_EXCLUDED.includes(r.kpi_group));
const withSpend = new Set(eligible.filter((r) => r.amount !== 0).map((r) => r.facility));
const unaccounted = [...withSpend].filter(
  (f) => !cpb.counted.includes(f) && !cpb.spendWithoutBeds.includes(f),
);
ok(unaccounted.length === 0,
   "every facility with spend is either counted or disclosed, never silently dropped",
   unaccounted.length ? unaccounted.join(", ") : `${withSpend.size} facilities`);

const countedCents = eligible
  .filter((r) => cpb.counted.includes(r.facility))
  .reduce((s, r) => s + cents(r.amount), 0);
ok(countedCents === cents(cpb.amount),
   "the numerator is exactly the counted facilities' eligible spend — no one else's",
   `${money(countedCents)}`);

/* THE DEFINITION ITSELF. Cost per bed is operating expense LESS marketing, so
   neither excluded group may reach the numerator — and the disclosed
   `excluded` must account for the whole difference from total spend, or the
   card's "excludes $X" line understates what was taken out. */
const excludedCents = rows
  .filter((r) => cpb.counted.includes(r.facility) && PER_BED_EXCLUDED.includes(r.kpi_group))
  .reduce((s, r) => s + cents(r.amount), 0);
ok(excludedCents === cents(cpb.excluded),
   "the disclosed exclusion is exactly the COGS + marketing removed from the counted facilities",
   money(excludedCents));

const countedTotalCents = rows
  .filter((r) => cpb.counted.includes(r.facility))
  .reduce((s, r) => s + cents(r.amount), 0);
ok(cents(cpb.amount) + cents(cpb.excluded) === countedTotalCents,
   "numerator + disclosed exclusion equals the counted facilities' total spend",
   `${money(cents(cpb.amount))} + ${money(cents(cpb.excluded))} = ${money(countedTotalCents)}`);
ok(cents(cpb.amount) < countedTotalCents,
   "the numerator is genuinely smaller than total spend — the exclusion is doing something",
   `${money(cents(cpb.amount))} vs ${money(countedTotalCents)}`);

/* A&M specifically, because that is the change this definition exists for. */
const advCents = rows
  .filter((r) => cpb.counted.includes(r.facility) && r.kpi_group === ADVERTISING_GROUP)
  .reduce((s, r) => s + cents(r.amount), 0);
ok(advCents > 0, "there is marketing spend to exclude in the first place", money(advCents));
ok(cents(cpb.amount) + advCents <= countedTotalCents,
   "no marketing dollar survives in the numerator", money(advCents));

const bedMap = new Map(beds.filter((b) => b.beds != null).map((b) => [b.facility, b.beds!]));
const countedBeds = cpb.counted.reduce((s, f) => s + (bedMap.get(f) ?? 0), 0);
ok(countedBeds === cpb.beds,
   "the denominator is exactly those same facilities' beds", `${countedBeds} beds`);

ok(cpb.spendWithoutBeds.every((f) => !bedMap.has(f)),
   "nothing on the no-bed-count list actually has a bed count");
ok(cpb.bedsWithoutSpend.every((f) => bedMap.has(f) && !withSpend.has(f)),
   "nothing on the beds-without-spend list actually has spend");

console.log(`\nno bed count on file : ${cpb.spendWithoutBeds.join(", ") || "(none)"}`);
console.log(`beds but no spend    : ${cpb.bedsWithoutSpend.join(", ") || "(none)"}`);
console.log(`counted (${cpb.counted.length}): ${cpb.counted.join(", ")}`);

/* A zero or absent bed count must never reach the division. 0 would be
   Infinity on screen; the DB check constraint forbids it, and this asserts the
   TypeScript agrees rather than trusting the constraint alone. */
const poisoned = costPerBed(
  [{ facility: "X", kpi_group: "Payroll Expenses", amount: 100, n: 1 }],
  [{ facility: "X", beds: 0 }],
);
ok(poisoned.perBed === null && poisoned.spendWithoutBeds.includes("X"),
   "a zero bed count is treated as absent, never divided by");

const noSpend = costPerBed([], [{ facility: "Y", beds: 10 }]);
ok(noSpend.perBed === null && noSpend.bedsWithoutSpend.includes("Y"),
   "a facility with beds and no spend reports as such rather than $0 per bed");

/* A facility whose ONLY activity is excluded must not enter the ratio as a
   zero — that would add its beds to the denominator and nothing to the
   numerator, understating every other facility. It is disclosed instead. */
const marketingOnly = costPerBed(
  [
    { facility: "Z", kpi_group: ADVERTISING_GROUP, amount: 50_000, n: 3 },
    { facility: "Z", kpi_group: COGS_GROUP, amount: 10_000, n: 1 },
  ],
  [{ facility: "Z", beds: 10 }],
);
ok(marketingOnly.perBed === null && marketingOnly.beds === 0 && marketingOnly.bedsWithoutSpend.includes("Z"),
   "a facility with only COGS and marketing contributes no beds and no spend");

/* And the ordinary case, by hand: 100k payroll + 40k marketing + 10k COGS over
   10 beds is 10k/bed, not 15k/bed. */
const mixed = costPerBed(
  [
    { facility: "M", kpi_group: "Payroll Expenses", amount: 100_000, n: 5 },
    { facility: "M", kpi_group: ADVERTISING_GROUP, amount: 40_000, n: 2 },
    { facility: "M", kpi_group: COGS_GROUP, amount: 10_000, n: 1 },
  ],
  [{ facility: "M", beds: 10 }],
);
ok(mixed.perBed === 10_000 && mixed.amount === 100_000 && mixed.excluded === 50_000,
   "a mixed facility divides operating-less-marketing by beds",
   `$${mixed.perBed}/bed, numerator $${mixed.amount}, excluded $${mixed.excluded}`);
ok(PER_BED_EXCLUDED.includes(ADVERTISING_GROUP) && PER_BED_EXCLUDED.includes(COGS_GROUP),
   "both groups are named in one exported constant the UI and this file share");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
