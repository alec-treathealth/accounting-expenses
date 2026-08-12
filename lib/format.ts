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

/* KPI group → design-system chart series slot.
   The series is ordered for categorical data: slots 1-4 stay distinguishable
   under deuteranopia (which is why info/blue precedes warn/amber), so the four
   largest groups — together ~85% of spend and the ones actually scanned — take
   those. Slots 7-8 are this app's extension of the shipped 6-slot series,
   because the taxonomy has eight groups.

   Slot 8 is --color-danger, and that is deliberate rather than decorative:
   "Unclassified expense" is the data-quality exception the header banner
   already warns about, so severity is the correct reading. Every other group
   uses an accent/coral/status ramp step, never danger. */
export const GROUP_COLOR: Record<string, string> = {
  "Payroll Expenses": "--chart-1",
  "General Business Expenses": "--chart-2",
  "Contract Labor": "--chart-3",
  "Cost of Goods Sold": "--chart-4",
  "Advertising & Marketing": "--chart-5",
  "Other Business Expenses": "--chart-6",
  "IT Expense": "--chart-7",
  "Unclassified expense": "--chart-8",
  Unmapped: "--chart-8",
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
