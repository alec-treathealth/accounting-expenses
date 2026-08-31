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

/* Plain names only. August used to be "Aug*", with the asterisk meaning
   "partial" — but whether a month is partial is a fact about the calendar
   (lib/pivot.ts partialMonth), not about the label, and baking it in here left
   a complete August wearing a stale star. Callers that mark the partial month
   derive the marker next to partialMonth(). */
export const MONTH_LABEL: Record<string, string> = {
  "2026-04": "Apr",
  "2026-05": "May",
  "2026-06": "Jun",
  "2026-07": "Jul",
  "2026-08": "Aug",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-07" -> "July".
 *
 *  Pure string/number math, never a Date, and that is the whole point. The month
 *  picker used to do `new Date("2026-07-01").toLocaleString("en-US", {month:"long"})`.
 *  The date-only ISO form parses as UTC midnight, and toLocaleString renders it
 *  in the VIEWER's zone, so at any negative UTC offset every label came out one
 *  month early: April read "March" and July read "June", which made July look
 *  deleted (August had a hardcoded label, so nothing was left saying "July").
 *  The data was never wrong — only the caption. It also caused a hydration
 *  mismatch, since the server renders in UTC and the browser does not. */
export const monthName = (period: string): string =>
  MONTH_NAMES[Number(period.slice(5, 7)) - 1] ?? period;

/** A warehouse timestamp as "Aug 31, 2026, 12:34 AM PDT" — always Pacific,
 *  the business's zone, never the viewer's, so two people reading the tag see
 *  the same freshness. A full timestamp (unlike a date-only string) parses as
 *  an absolute instant, so `new Date(iso)` is safe here. */
export const updatedStamp = (iso: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
