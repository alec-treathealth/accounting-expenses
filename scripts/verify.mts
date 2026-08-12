import { readFileSync } from "fs";
import { ingestCsv } from "../lib/parse.ts";

const path = "/mnt/user-data/uploads/accounting/Consolidated View_Consolidated transaction detail backfill.csv";
const r = ingestCsv(readFileSync(path, "utf8"));

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
console.log("fact rows        :", r.factRows.length);
console.log("total            : $" + r.total.toFixed(2));
console.log("EXPECTED total   : $19709887.26");
console.log("MATCH            :", r.total.toFixed(2) === "19709887.26" ? "YES ✅" : "NO ❌");
console.log("aggGroupMonth    :", r.aggGroupMonth.length, "rows, sum $" + sum(r.aggGroupMonth.map((x) => x.amount)).toFixed(2));
console.log("aggAccount       :", r.aggAccount.length, "rows, sum $" + sum(r.aggAccount.map((x) => x.amount)).toFixed(2));
console.log("aggVendor        :", r.aggVendor.length, "rows");
console.log("months           :", r.monthsPresent.join(", "));
console.log("facilities        :", r.facilitiesPresent.length, "->", r.facilitiesPresent.join(", "));
console.log("max occurrence idx:", Math.max(...r.factRows.map((f) => f.occurrence)), "(0 = no identical repeats)");
// idempotency proof: re-run identity set must be stable
const keys = new Set(r.factRows.map((f) => f.row_key + ":" + f.occurrence));
console.log("unique (row_key,occurrence):", keys.size, "of", r.factRows.length, keys.size === r.factRows.length ? "✅ unique" : "❌ collision");
