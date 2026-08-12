export const usd = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString();

// Cents-exact, for transaction detail and reconciliation figures where a
// rounded dollar amount would hide a mismatch.
export const usdExact = (n: number) =>
  (n < 0 ? "-" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const usdShort = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k";
  return "$" + Math.round(n);
};

export const pct = (n: number) => (n * 100).toFixed(1) + "%";

export const GROUP_COLOR: Record<string, string> = {
  "Payroll Expenses": "--g1",
  "General Business Expenses": "--g2",
  "Contract Labor": "--g3",
  "Cost of Goods Sold": "--g4",
  "Advertising & Marketing": "--g5",
  "Other Business Expenses": "--g6",
  "IT Expense": "--g7",
  "Unclassified expense": "--g8",
  Unmapped: "--g8",
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

export const MONTH_LABEL: Record<string, string> = {
  "2026-04": "Apr",
  "2026-05": "May",
  "2026-06": "Jun",
  "2026-07": "Jul",
  "2026-08": "Aug*",
};
