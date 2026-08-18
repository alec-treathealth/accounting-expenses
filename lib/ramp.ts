import { GROUP_ORDER } from "./format";

// ---------------------------------------------------------------------------
// Pure arithmetic for Ramp card spend by cardholder.
//
// No React, no I/O — which is what lets verify/ramp.mts assert every one of
// these against the live warehouse with no browser and no test framework.
//
// THE ONE THING TO KNOW: these rows are a SLICE of agg_group_month, not an
// addition to it. Every dollar here is already counted in the dashboard's
// total. Adding a Ramp figure to a dashboard figure double-counts. (No literal
// total is pinned here: it moves with every ingest, and a stale one in a comment
// is read as fact long after it stops being one.)
// ---------------------------------------------------------------------------

export type RampPersonRow = {
  facility: string;
  /** "YYYY-MM". The provider slices the date before it reaches here. */
  posted_period: string;
  person: string;
  kpi_group: string;
  amount: number;
  n: number;
};

export type RampVendorRow = {
  facility: string;
  person: string;
  vendor: string;
  amount: number;
  n: number;
  /** 1..12 — rank WITHIN (facility, person). Exposed so the UI can say so. */
  rk: number;
};

/** The label public.ramp_person() gives rows with no description. */
export const UNATTRIBUTED = "(unattributed)";

/**
 * Shared exec/admin cards, hidden from the CARDHOLDER BREAKDOWN ONLY.
 *
 * These six cards are used to buy on behalf of many entities at once, so the
 * one name on the card is not the thing the money was spent on. Ranking them
 * beside a facility manager's card answers "who holds the biggest card", which
 * nobody is asking, instead of "whose spending should I look at", which is the
 * whole point of this tab.
 *
 * THIS IS A PRESENTATION FILTER, NOT A SCOPE DECISION. Their spend is real and
 * stays in fact_txn, agg_group_month, agg_account, agg_vendor and every
 * categorical / vendor / account / facility view, under their own names. They
 * are roughly half of all Ramp spend, so ANY total computed off the unfiltered
 * table while this filter is applied to the list will disagree with the list —
 * always derive both from the same filtered rows. (Exact shares are deliberately
 * not pinned here; verify:ramp prints the current ones.)
 *
 * Strings match agg_ramp_person.person exactly, i.e. the output of
 * public.ramp_person(description). Verified against the live table.
 */
export const EXCLUDED_RAMP_CARDHOLDERS: readonly string[] = [
  "Gia Laubertie",
  "Blake Vincent",
  "Sophie Gomes",
  "Ravinand Mathoera",
  "Tara Vincent",
  "Shayla Linn",
];

const EXCLUDED_SET: ReadonlySet<string> = new Set(EXCLUDED_RAMP_CARDHOLDERS);

/** True when a cardholder is one of the shared exec/admin cards above. */
export function isExcludedRampCardholder(person: string): boolean {
  return EXCLUDED_SET.has(person);
}

/**
 * Drop the shared exec/admin cards from any row set carrying a `person`.
 *
 * Generic on purpose: agg_ramp_person and agg_ramp_vendor have different shapes
 * but both key on `person`, and both feed this tab. One function means the two
 * cannot drift out of step — which would show a cardholder in a merchant
 * drilldown who is absent from the list beside it.
 */
export function excludeRampCardholders<T extends { person: string }>(rows: T[]): T[] {
  return rows.filter((r) => !EXCLUDED_SET.has(r.person));
}

/** agg_ramp_vendor keeps this many merchants per facility-and-person. */
export const VENDOR_TOP_N = 12;

export type Tally = { amount: number; n: number };

export type PersonTotal = Tally & {
  person: string;
  /** Facilities this person charged against, within the current filter. */
  facilities: string[];
};

export type RampFilter = {
  facility?: string | null;
  /** "YYYY-MM" */
  month?: string | null;
  person?: string | null;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/* "All" is the value the shell's facility and month SELECTS carry when nothing
   is picked, so it is normalised out here rather than at every call site.

   It applies to those two ONLY. `person` is never a select — it comes from a
   selection in the ranked list — so it is matched literally. Extending the
   sentinel to it would mean a cardholder who happened to be recorded as "All"
   silently matched everyone, which is the kind of bug that shows up as a number
   nobody can explain. */
const unset = (v: string | null | undefined) => !v || v === "All";

export function filterRamp(rows: RampPersonRow[], f: RampFilter): RampPersonRow[] {
  return rows.filter(
    (r) =>
      (unset(f.facility) || r.facility === f.facility) &&
      (unset(f.month) || r.posted_period === f.month) &&
      (f.person == null || r.person === f.person),
  );
}

export function total(rows: { amount: number; n: number }[]): Tally {
  let amount = 0;
  let n = 0;
  for (const r of rows) {
    amount += r.amount;
    n += r.n;
  }
  // Round once at the end; rounding each addend drifts by cents over 1,493 rows.
  return { amount: r2(amount), n };
}

/**
 * Cardholders ranked by spend, high to low — the shape the Card Spend
 * list renders directly.
 *
 * Ties break on name so the order is stable across renders. Without that, two
 * people at the same amount could swap places on every re-render and the list
 * would appear to flicker.
 */
export function rankPeople(rows: RampPersonRow[]): PersonTotal[] {
  const acc = new Map<string, { amount: number; n: number; facs: Set<string> }>();
  for (const r of rows) {
    let cur = acc.get(r.person);
    if (!cur) {
      cur = { amount: 0, n: 0, facs: new Set() };
      acc.set(r.person, cur);
    }
    cur.amount += r.amount;
    cur.n += r.n;
    cur.facs.add(r.facility);
  }
  return [...acc.entries()]
    .map(([person, v]) => ({
      person,
      amount: r2(v.amount),
      n: v.n,
      facilities: [...v.facs].sort(),
    }))
    .sort((a, b) => b.amount - a.amount || a.person.localeCompare(b.person));
}

/** Spend by KPI group, in the house order used everywhere else in the app. */
export function byGroup(rows: RampPersonRow[]): (Tally & { kpi_group: string })[] {
  const acc = new Map<string, Tally>();
  for (const r of rows) {
    const cur = acc.get(r.kpi_group);
    if (cur) {
      cur.amount += r.amount;
      cur.n += r.n;
    } else {
      acc.set(r.kpi_group, { amount: r.amount, n: r.n });
    }
  }
  const rank = new Map(GROUP_ORDER.map((g, i) => [g, i]));
  return [...acc.entries()]
    .map(([kpi_group, v]) => ({ kpi_group, amount: r2(v.amount), n: v.n }))
    .sort((a, b) => (rank.get(a.kpi_group) ?? 999) - (rank.get(b.kpi_group) ?? 999));
}

/**
 * Spend per month over a FIXED month list, so a person with no April spend
 * still renders an April column. Returning only the months present would make
 * two people's trend charts silently use different x-axes.
 */
export function byMonth(rows: RampPersonRow[], months: readonly string[]): (Tally & { month: string })[] {
  const acc = new Map<string, Tally>();
  for (const m of months) acc.set(m, { amount: 0, n: 0 });
  for (const r of rows) {
    const cur = acc.get(r.posted_period);
    if (!cur) continue; // a month outside the known window is not silently folded in
    cur.amount += r.amount;
    cur.n += r.n;
  }
  return months.map((month) => {
    const v = acc.get(month)!;
    return { month, amount: r2(v.amount), n: v.n };
  });
}

export type VendorSlice = {
  rows: (Tally & { vendor: string })[];
  /** Sum of the rows above. */
  shown: Tally;
  /** The all-months denominator `shown` is a fraction of. */
  covered: Tally;
  /** shown / covered, as a percentage, or null if there is nothing to divide by. */
  coverage: number | null;
};

/**
 * A person's merchants, highest first, with the share of their spend covered.
 *
 * agg_ramp_vendor holds only the top 12 per (facility, person), so this list is
 * DELIBERATELY INCOMPLETE and `shown` will be less than the person's true total.
 * The caller must print the coverage — a truncated list that looks complete is a
 * lie, and on a financial screen that is the expensive kind of lie.
 *
 * IT TAKES THE ROWS, NOT A TOTAL, AND THAT IS THE POINT. agg_ramp_vendor has no
 * month dimension — its key is (facility, person, vendor) — so `shown` always
 * spans every month. An earlier version accepted a pre-computed total and the
 * only caller handed it a MONTH-SCOPED one, which printed "$41,203 of $9,120
 * (452%). The remainder is spread across smaller merchants."
 *
 * Deriving the denominator here does not make that impossible — hand this
 * function month-scoped rows and it will still divide by them. What it does is
 * put the numerator and the denominator under one roof, so the two can only
 * disagree if the CALLER passes the wrong set, which verify/ramp.mts asserts it
 * does not.
 *
 * When no facility is pinned, a vendor appearing in several facilities' top 12
 * is summed across them. Each contribution is exact; what is missing is the
 * facilities where that vendor fell below rank 12 — precisely what `coverage`
 * discloses.
 */
export function topVendorsFor(
  vendors: RampVendorRow[],
  /** EVERY month's rows. Passing a month-scoped set is the bug described above. */
  allMonthRows: RampPersonRow[],
  person: string,
  facility: string | null | undefined,
): VendorSlice {
  const acc = new Map<string, Tally>();
  for (const v of vendors) {
    if (v.person !== person) continue;
    if (!unset(facility) && v.facility !== facility) continue;
    const cur = acc.get(v.vendor);
    if (cur) {
      cur.amount += v.amount;
      cur.n += v.n;
    } else {
      acc.set(v.vendor, { amount: v.amount, n: v.n });
    }
  }
  const rows = [...acc.entries()]
    .map(([vendor, v]) => ({ vendor, amount: r2(v.amount), n: v.n }))
    .sort((a, b) => b.amount - a.amount || a.vendor.localeCompare(b.vendor));

  const shown = total(rows);
  const covered = total(filterRamp(allMonthRows, { facility, person }));
  return { rows, shown, covered, coverage: share(shown.amount, covered.amount) };
}

/** Share of a whole, guarded so a zero or negative denominator reports null
 *  rather than Infinity or a negative percentage that reads as a decrease. */
export function share(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 1000) / 10;
}
