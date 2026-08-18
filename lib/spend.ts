// ---------------------------------------------------------------------------
// The two spend denominators the Dashboard reports, and cost per licensed bed.
//
// Pure arithmetic over agg_group_month rows. No React, no I/O — which is what
// lets verify/spend.mts assert all of it against the live warehouse.
//
// ONE HELPER, TWO CARDS. "Operating Expenses" and "COGS + Expenses" are the same
// arithmetic read two ways, and Cost per Bed divides the second of them. Working
// any of the three out separately is how two cards on one screen come to
// disagree, so they all come from splitSpend() below.
// ---------------------------------------------------------------------------

/**
 * The single KPI group that is cost of goods sold.
 *
 * WHY THE GROUP AND NOT `kind`. map_account_group carries both a `kind`
 * ('COGS' | 'EXP') and a `kpi_group`, and today they agree exactly: the 13
 * accounts with kind='COGS' are precisely the 'Cost of Goods Sold' group.
 * agg_group_month — the only aggregate with a facility and a month, so the only
 * one that can honour this page's filters — carries the GROUP and not the kind.
 *
 * That is also the right authority. The README makes map_account_group the
 * authoritative taxonomy and /admin lets a person re-map an account's group; it
 * cannot edit `kind`, which is a coarse artefact of the account number (5=COGS).
 * So when a human moves an account out of Cost of Goods Sold they have decided
 * it is not COGS, and this figure should follow them. verify/spend.mts asserts
 * the two definitions still agree and says so loudly when they stop.
 */
export const COGS_GROUP = "Cost of Goods Sold";

export type SpendRow = { kpi_group: string; amount: number; n: number };

export type SpendSplit = {
  /** Cost of Goods Sold only. */
  cogs: number;
  /** Everything that is not COGS — the operating-expense figure. */
  operating: number;
  /** cogs + operating. The total the Dashboard has always reported. */
  all: number;
  /** Transaction count behind `all`. */
  n: number;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Split a set of agg_group_month rows into COGS and operating expense.
 *
 * Rounded once at the end. Rounding each addend drifts by cents over the
 * ~500 rows the unfiltered dashboard passes in.
 */
export function splitSpend(rows: readonly SpendRow[]): SpendSplit {
  let cogs = 0;
  let operating = 0;
  let n = 0;
  for (const r of rows) {
    if (r.kpi_group === COGS_GROUP) cogs += r.amount;
    else operating += r.amount;
    n += r.n;
  }
  return { cogs: r2(cogs), operating: r2(operating), all: r2(cogs + operating), n };
}

export type FacilitySpendRow = SpendRow & { facility: string };

/** A facility's licensed capacity. `null` means no bed count is on file. */
export type BedCount = { facility: string; beds: number | null };

export type CostPerBed = {
  /** Total spend / total beds, or null when nothing can be divided. */
  perBed: number | null;
  /** Numerator: COGS + operating expense for the counted facilities ONLY. */
  amount: number;
  /** Denominator: licensed beds for those same facilities. */
  beds: number;
  /** Facilities inside both the filter and the ratio. */
  counted: string[];
  /** In view with spend, but no bed count on file — disclosed, never dropped. */
  spendWithoutBeds: string[];
  /** Has a bed count, but no spend in this view — disclosed, never $0. */
  bedsWithoutSpend: string[];
};

/**
 * Cost per licensed bed.
 *
 * IT IS COST PER BED, NOT PER CLIENT. There is no census or occupancy anywhere
 * in this database, so this cannot be a per-client figure and must not be
 * labelled as one — a bed that sat empty all month counts the same as a full
 * one.
 *
 * THE NUMERATOR AND DENOMINATOR ARE SCOPED IDENTICALLY, which is the whole
 * difficulty. A facility with no bed count contributes to NEITHER: counting its
 * spend against everyone else's beds inflates the ratio silently, which is
 * exactly the kind of wrong number that survives a review because it looks
 * plausible. Those facilities come back in `spendWithoutBeds` so the card can
 * name them instead.
 *
 * California Treatment Collective falls out here naturally, with no special
 * case: it has no bed count on file, so it is absent from both sides and named
 * in `spendWithoutBeds`. That is deliberate and must stay that way — it is
 * excluded from THIS RATIO ONLY, and its spend remains in every other view and
 * every org-wide total. Do not "fix" this by inventing a capacity for it.
 */
export function costPerBed(
  rows: readonly FacilitySpendRow[],
  capacity: readonly BedCount[],
  /** Facilities in view, so a filtered-out facility is not reported as missing. */
  inView?: (facility: string) => boolean,
): CostPerBed {
  const beds = new Map<string, number>();
  for (const c of capacity) {
    if (c.beds != null && c.beds > 0) beds.set(c.facility, c.beds);
  }

  const spend = new Map<string, number>();
  for (const r of rows) spend.set(r.facility, (spend.get(r.facility) ?? 0) + r.amount);

  const counted: string[] = [];
  const spendWithoutBeds: string[] = [];
  let amount = 0;
  let bedTotal = 0;

  /* ONE RULE FOR "NO SPEND". A facility can have no rows at all, or rows that
     net to exactly zero (a reversal inside the filtered window). Those are the
     same fact and must be treated the same way: counting the second kind would
     add its beds to the denominator and nothing to the numerator, quietly
     diluting the ratio for every other facility. Both now fall through to the
     bedsWithoutSpend disclosure below. */
  for (const [facility, amt] of spend) {
    if (amt === 0) continue;
    if (beds.has(facility)) {
      counted.push(facility);
      amount += amt;
      bedTotal += beds.get(facility)!;
    } else {
      spendWithoutBeds.push(facility);
    }
  }

  /* A facility with beds and no spend is the other half of the same disclosure.
     It is NOT folded into the ratio as a zero: that would divide real spend by
     capacity that reported nothing and quietly understate every other facility. */
  const bedsWithoutSpend: string[] = [];
  for (const facility of beds.keys()) {
    if ((spend.get(facility) ?? 0) !== 0) continue; // genuinely spent something
    if (inView && !inView(facility)) continue;
    bedsWithoutSpend.push(facility);
  }

  return {
    perBed: bedTotal > 0 ? r2(amount / bedTotal) : null,
    amount: r2(amount),
    beds: bedTotal,
    counted: counted.sort(),
    spendWithoutBeds: spendWithoutBeds.sort(),
    bedsWithoutSpend: bedsWithoutSpend.sort(),
  };
}
