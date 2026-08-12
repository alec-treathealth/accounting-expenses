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

function isAcct(c0: string): boolean {
  return /^\d/.test(c0) || /\(\d{3,}\)/.test(c0);
}

// Deterministic non-crypto hash (FNV-1a, 32-bit) used as a row identity for
// idempotent append, paired with an occurrence index so two legitimately
// identical transactions are NOT collapsed into one.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
}

export function ingestCsv(text: string): IngestResult {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const rows = (parsed.data as string[][]) || [];

  let start = 0;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    if ((rows[i]?.[1] || "").trim() === "Transaction date") { start = i + 1; break; }
  }

  let curCo: string | null = null;
  let curAcct: string | null = null;
  const facts: FactRow[] = [];
  const occ = new Map<string, number>();

  for (let i = start; i < rows.length; i++) {
    const row = rows[i] || [];
    const c0 = (row[0] || "").trim();
    const rest = row.slice(1).map((x) => (x || "").trim());
    if (row.length === 0 || (c0 === "" && rest.every((x) => x === ""))) continue;
    if (c0.startsWith("Total")) continue;

    if (c0 && rest.every((x) => x === "")) {
      if (c0.startsWith("Accrual Basis")) continue;
      if (isAcct(c0)) curAcct = c0;
      else { curCo = c0; curAcct = null; }
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
  };
}
