// Name-based KPI classification for the QuickBooks "Consolidated transaction
// detail" export. Account NUMBERS are not stable across the 80+ entities in the
// consolidated file (e.g. 7040 is "Payroll Taxes" in some entities and
// "Income from Capital One" in others), so we classify on the account NAME and
// use the number only to identify the coarse class (5=COGS, 6/7=expense).

export const FACILITY: Record<string, string> = {
  "California Mental Health LLC": "California MH",
  "California Treatment Collective, LLC.": "California Treatment Collective",
  "Dallas Mental Health LLC": "Dallas Mental Health",
  "Hillside Horizon for Teens": "Hillside",
  "Houston Mental Health LLC": "Houston Mental Health",
  "Kentucky Wellness Center": "Kentucky Mental Health",
  "Lonestar Mental Health": "Lonestar",
  "Los Angeles Mental Health": "Los Angeles MH",
  "Nashville Mental Health": "Nashville MH",
  "Northern California Mental Health": "Northern California Mental Health",
  "Opus Health, LLC": "Opus Health",
  "Pacific Coast Mental Health": "Pacific MH",
  "Revival Mental Health LLC": "Revival MH",
  "Silicon Valley Recovery LLC": "Silicon Valley Recovery",
  "St Louis Mental Health, LLC": "St. Louis Mental Health",
  "Tennessee Behavioral Health": "Tennessee Behavioral",
};

export const GROUP_ORDER = [
  "Payroll Expenses",
  "General Business Expenses",
  "Contract Labor",
  "Cost of Goods Sold",
  "Advertising & Marketing",
  "Other Business Expenses",
  "IT Expense",
  "Unclassified expense",
];

// Names that are income / contra even though they sit in a 6/7 number range.
const EXCLUDE = [
  "income",
  "interest earned",
  "guaranteed payment",
  "credit card reward",
  "credit card rrewards",
  "reward",
];

export function normName(label: string): string {
  return label.replace(/^\d+\s*/, "").trim().toLowerCase();
}

export type Kind = "COGS" | "EXP";

export function classify(label: string): { kind: Kind | null; group: string | null } {
  const n = normName(label);
  const m = label.match(/^(\d+)/);
  const d = m ? m[1][0] : null;
  const has = (...ks: string[]) => ks.some((k) => n.includes(k));

  if (EXCLUDE.some((k) => n.includes(k))) return { kind: null, group: null };
  if (d === "5") return { kind: "COGS", group: "Cost of Goods Sold" };
  if (d === "6" || d === "7") {
    if (has("ppc", "pay per click", "website", "seo", "advertis", "marketing"))
      return { kind: "EXP", group: "Advertising & Marketing" };
    if (n.includes("contract labor") || n.includes("casual labor"))
      return { kind: "EXP", group: "Contract Labor" };
    // "it expense" must match on WORD boundaries. A plain substring test also
    // matches "...Medical VisIT EXPENSE", which put 6165 Employee Laboratory or
    // Medical Visit Expense in IT Expense.
    if (n === "it" || /\bit\s+expenses?\b/.test(n) || n.includes("software"))
      return { kind: "EXP", group: "IT Expense" };
    if (has("payroll", "salaries", "wages", "401k", "health insurance", "employee health", "benefit"))
      return { kind: "EXP", group: "Payroll Expenses" };
    if (has("office expense", "supplies", "travel", "repair", "maintenance", "charit", "contribution", "entertainment", "meal"))
      return { kind: "EXP", group: "Other Business Expenses" };
    if (
      has(
        "license", "consulting", "education", "training", "reimbursement", "hiring", "recruit",
        // employee lab work / medical visits (pre-hire screens, licensing checks):
        // an employee-related operating cost, grouped with hiring & training. The
        // "supplies" test above still claims e.g. "medical supplies" first.
        "laboratory", "medical",
        "utilit", "gas and electric", "electric", "water", "cable", "internet", "rent", "insurance",
        "interest", "legal", "accounting", "vehicle", "honda", "lease", "auto", "ftb", "tax",
        "bank fee", "service charge", "dues", "subscription", "phone", "telephone", "postage",
        "security", "venmo", "other expense", "fee"
      )
    )
      return { kind: "EXP", group: "General Business Expenses" };
    return { kind: "EXP", group: "Unclassified expense" };
  }
  return { kind: null, group: null };
}
