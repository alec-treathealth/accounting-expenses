// Parser + aggregator for the QuickBooks "Consolidated transaction detail"
// report export. The report is grouped company -> account -> transactions, with
// the offsetting account in the "Split" column. The SAME transaction appears
// under both its funding account and its expense account, so summing the whole
// report double-counts; we keep only rows whose SECTION account is an
// expense/COGS account (see classify()), which counts each expense leg once.
//
// Runs identically in the browser (drag-drop upload) and in Node (tests).

import Papa from "papaparse";
import { FACILITY, classify, type Kind } from "./classify";

const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const SEP = ""; // delimiter that never appears in the data

function money(s: string): number | null {
  if (!s) return null;
  let t = s.trim().replace(/\$/g, "").replace(/,/g, "");
  if (t === "") return null;
  const neg = t.startsWith("(") && t.endsWith(")");
  t = t.replace(/^\(|\)$/g, "");
  const v = parseFloat(t);
  if (Number.isNaN(v)) return null;
  return neg ? -v : v;
}

// The report nests exactly two levels — company > account > transactions — and
// closes EVERY section with a "Total for <that section's name>" row. Tracking
// those opens and closes as a stack makes the nesting itself say which level a
// header is at, so no rule has to be guessed from the shape of the name.
//
// WHAT THIS REPLACED, AND WHY IT MATTERED. The old test was
//   isAcct = /^\d/.test(c0) || /\(\d{3,}\)/.test(c0)
// i.e. "an account starts with a number". Any account that does NOT — and this
// export contains several, e.g. "DON'T USE! Due To R&B Mgmt (deleted)",
// "Donations from Pass-Through", "Phone service", "Sales", "Accounting" — was
// read as a new COMPANY. From that row to the end of the company's section,
// every remaining account was attributed to a company that does not exist, and
// because that name is not in FACILITY, every one of those rows was silently
// dropped.
//
// Nashville Mental Health lost 6,381 of its 7,322 rows that way: its section
// runs 1010, 1100, 1200, 1500, 2000, then "DON'T USE! Due To R&B Mgmt
// (deleted)" — and everything after it, including 2030 Ramp Card and all 20+
// expense accounts, went to the phantom. The facility reported $0 while being
// fully present in the source, and no reconciliation could notice: the dropped
// rows are absent from both sides of every tie-out.
const TOTAL_FOR = "Total for ";

/**
 * Section stack: [0] is the company, [1] the account.
 *
 * EVERY departure from the expected shape is recorded in `anom` rather than
 * absorbed. That is the whole point: the bug above was catastrophic precisely
 * because it was SILENT, and a parser that quietly re-files 6,000 rows is worse
 * than one that refuses the file. Dropping a single "Total for ..." line from
 * the real export makes this function file all 104,153 rows under one company;
 * with the anomaly list, that upload is blocked instead of ingested.
 */
function applySection(stack: string[], c0: string, anom: string[]): void {
  if (c0.startsWith(TOTAL_FOR)) {
    const name = c0.slice(TOTAL_FOR.length);
    // Pop TO the match, not off the top. Popping only on an exact top match
    // leaves an unclosed section on the stack forever, and everything after it
    // nests one level too deep; searching for the match self-heals a missing
    // close and still says so.
    const at = stack.lastIndexOf(name);
    if (at >= 0) {
      if (at < stack.length - 1) {
        anom.push(`"${TOTAL_FOR}${name}" closed while ${stack.slice(at + 1).join(" > ")} was still open`);
      }
      stack.length = at;
    } else if (name !== "--") {
      // QuickBooks emits an unnamed section as a BLANK header row closed by
      // "Total for --", so that one open legitimately never existed.
      anom.push(`"${TOTAL_FOR}${name}" closes a section that was never opened`);
    }
    return;
  }
  if (stack.length >= 2) anom.push(`nesting deeper than company > account at "${c0}"`);
  stack.push(c0);
}

// Deterministic non-crypto hash (FNV-1a, 64-bit) used as a row identity for
// idempotent append, paired with an occurrence index so two legitimately
// identical transactions are NOT collapsed into one.
//
// SIXTY-FOUR BITS, NOT THIRTY-TWO. This was a 32-bit hash. At 34,056 rows the
// birthday bound puts a collision inside one load at roughly 12% — and a
// collision is not a loud failure here: two different transactions that hash
// alike both land at occurrence 0, so ON CONFLICT DO NOTHING silently discards
// the second one and the warehouse is quietly short a row. Sixty-four bits puts
// that at about 1 in 16 million for the same volume.
//
// Widening re-keys every row, so it can only be done during a full reload; it
// was done as part of the section-parser rebuild rather than deferred, because
// the next opportunity would have cost a second one.
//
// BigInt is fast enough: 75ms for 34,056 rows, and this runs once per upload.
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64 = (1n << 64n) - 1n;

function fnv1a(str: string): string {
  let h = FNV64_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV64_PRIME) & U64;
  }
  return h.toString(16).padStart(16, "0");
}

export interface FactRow {
  facility: string;
  txn_date: string; // YYYY-MM-DD
  posted_period: string; // YYYY-MM-01
  txn_type: string;
  num: string;
  name: string;
  description: string;
  split: string;
  account_num: string | null;
  account_label: string;
  kpi_group: string;
  kind: Kind;
  amount: number;
  row_key: string;
  occurrence: number;
}

export interface AggGroupMonth { facility: string; posted_period: string; kpi_group: string; amount: number; n: number; }
export interface AggAccount { account_label: string; account_num: string | null; kpi_group: string; kind: string; amount: number; n: number; }
export interface AggVendor { facility: string; vendor: string; kpi_group: string; amount: number; n: number; }

export interface IngestResult {
  factRows: FactRow[];
  aggGroupMonth: AggGroupMonth[];
  aggAccount: AggAccount[];
  aggVendor: AggVendor[];
  total: number;
  monthsPresent: string[];
  facilitiesPresent: string[];
  /** Structural surprises in the file. NON-EMPTY MEANS DO NOT COMMIT THIS LOAD. */
  anomalies: string[];
}

export function ingestCsv(text: string): IngestResult {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const rows = (parsed.data as string[][]) || [];

  /* Fail loud. Defaulting to 0 when the header is absent silently shifts every
     section by the banner rows, which parses to $0 and looks like an empty
     period rather than a rejected file. */
  let start = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    if ((rows[i]?.[1] || "").trim() === "Transaction date") { start = i + 1; break; }
  }
  if (start < 0) {
    throw new Error(
      'Not a "Consolidated transaction detail" export: no "Transaction date" header in the first 25 rows.',
    );
  }

  const anomalies: string[] = [];
  /** Transaction rows seen outside a company > account section. */
  const stray = { n: 0, amount: 0 };
  const stack: string[] = [];
  const facts: FactRow[] = [];
  const occ = new Map<string, number>();

  for (let i = start; i < rows.length; i++) {
    const row = rows[i] || [];
    const c0 = (row[0] || "").trim();
    const rest = row.slice(1).map((x) => (x || "").trim());
    if (row.length === 0 || (c0 === "" && rest.every((x) => x === ""))) continue;

    /* Order matters. A CLOSE carries its subtotal in the amount column, so it
       is NOT a "lone label" row and has to be recognised before that test —
       checking shape first would skip every close and the stack would only ever
       grow. An OPEN is the lone-label row. */
    if (c0.startsWith(TOTAL_FOR)) {
      // A "Total for --" that is not $0.00 would mean the unnamed section held
      // real money that never reached a named account. All are $0 today.
      if (c0.slice(TOTAL_FOR.length) === "--" && (money(row[7] || "") ?? 0) !== 0) {
        anomalies.push(`unnamed section "--" carries a non-zero subtotal ${row[7]}`);
      }
      applySection(stack, c0, anomalies);
      continue;
    }
    // Only the literal grand-total footer. A "startsWith" here would swallow any
    // real section whose name began with "Total"; "Total for " is handled above.
    if (c0 === "TOTAL") continue;
    if (c0 && rest.every((x) => x === "")) {
      if (c0.startsWith("Accrual Basis")) continue;
      applySection(stack, c0, anomalies);
      continue;
    }

    const curCo = stack[0];
    const curAcct = stack[1];

    /* A transaction that is not inside a company > account section cannot be
       filed, and dropping it quietly is the exact failure this whole parser
       change exists to remove. The three reasons to skip a row are NOT equal:
       "this company is out of scope" and "this account is not an expense" are
       decisions, but "this row had no enclosing account" is a structural
       surprise, and it gets recorded. The real export has 7 today, all voided
       and $0.00, so the amount is carried in the message rather than assumed
       harmless — a non-zero one means money went missing. */
    if (row.length >= 8 && DATE.test((row[1] || "").trim()) && !(curCo && curAcct)) {
      stray.n++;
      stray.amount += money(row[7] || "") ?? 0;
      continue;
    }

    if (row.length >= 8 && DATE.test((row[1] || "").trim()) && curAcct && curCo && FACILITY[curCo]) {
      const { kind, group } = classify(curAcct);
      if (!kind) continue;
      const amt = money(row[7] || "") ?? 0;
      const dt = (row[1] || "").trim();
      const iso = `${dt.slice(6, 10)}-${dt.slice(0, 2)}-${dt.slice(3, 5)}`;
      const period = `${dt.slice(6, 10)}-${dt.slice(0, 2)}-01`;
      const anum = (curAcct.match(/^(\d+)/) || [])[1] || null;
      const facility = FACILITY[curCo];
      const name = (row[4] || "").trim().slice(0, 120);
      const description = (row[5] || "").trim().slice(0, 200);
      const split = (row[6] || "").trim().slice(0, 120);
      const txn_type = (row[2] || "").trim().slice(0, 40);
      const num = (row[3] || "").trim().slice(0, 20);
      const label = curAcct.slice(0, 120);
      const amount = Math.round(amt * 100) / 100;
      const rk = fnv1a([facility, iso, txn_type, num, name, description, split, label, amount.toFixed(2)].join(SEP));
      const c = occ.get(rk) || 0;
      occ.set(rk, c + 1);
      facts.push({ facility, txn_date: iso, posted_period: period, txn_type, num, name, description, split, account_num: anum, account_label: label, kpi_group: group as string, kind, amount, row_key: rk, occurrence: c });
    }
  }

  if (stack.length) {
    anomalies.push(`unclosed at end of file: ${stack.join(" > ")}`);
  }
  /* Only when MONEY is at stake. Both real exports carry exactly 7 such rows —
     voided bill payments inside QuickBooks' unnamed "--" section — and they are
     all $0.00. Raising on those would block every legitimate upload, and a
     banner that fires on every correct file teaches people to click past the one
     that matters. A non-zero total means rows carrying real money had nowhere to
     be filed, which is the case worth stopping for. */
  const strayAmount = Math.round(stray.amount * 100) / 100;
  if (stray.n && strayAmount !== 0) {
    anomalies.push(
      `${stray.n} transaction row(s) outside a company > account section, ` +
        `totalling ${strayAmount.toFixed(2)} — money with nowhere to be filed`,
    );
  }

  const gm = new Map<string, [number, number]>();
  const aa = new Map<string, [number, number]>();
  const av = new Map<string, [number, number]>();
  const months = new Set<string>();
  const facs = new Set<string>();
  for (const f of facts) {
    months.add(f.posted_period.slice(0, 7));
    facs.add(f.facility);
    const gk = [f.facility, f.posted_period, f.kpi_group].join(SEP);
    const g = gm.get(gk) || [0, 0]; g[0] += f.amount; g[1] += 1; gm.set(gk, g);
    const a = aa.get(f.account_label) || [0, 0]; a[0] += f.amount; a[1] += 1; aa.set(f.account_label, a);
    const vk = [f.facility, f.name || "(no payee)", f.kpi_group].join(SEP);
    const v = av.get(vk) || [0, 0]; v[0] += f.amount; v[1] += 1; av.set(vk, v);
  }

  const r2 = (x: number) => Math.round(x * 100) / 100;
  const aggGroupMonth: AggGroupMonth[] = [...gm.entries()].map(([k, v]) => {
    const [facility, posted_period, kpi_group] = k.split(SEP);
    return { facility, posted_period, kpi_group, amount: r2(v[0]), n: v[1] };
  });
  const aggAccount: AggAccount[] = [...aa.entries()].map(([label, v]) => {
    const cl = classify(label);
    return { account_label: label, account_num: (label.match(/^(\d+)/) || [])[1] || null, kpi_group: cl.group || "Unclassified expense", kind: cl.kind || "", amount: r2(v[0]), n: v[1] };
  });
  const aggVendor: AggVendor[] = [...av.entries()]
    .map(([k, v]) => { const [facility, vendor, kpi_group] = k.split(SEP); return { facility, vendor, kpi_group, amount: r2(v[0]), n: v[1] }; })
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 150);

  return {
    factRows: facts,
    aggGroupMonth,
    aggAccount,
    aggVendor,
    total: r2(facts.reduce((s, f) => s + f.amount, 0)),
    monthsPresent: [...months].sort(),
    facilitiesPresent: [...facs].sort(),
    anomalies,
  };
}
