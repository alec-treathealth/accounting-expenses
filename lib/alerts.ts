import { usd } from "./format";

// ---------------------------------------------------------------------------
// Shape and vocabulary of an "out of the norm" Ramp charge.
//
// The rules live in public.ramp_alerts() (supabase/migrations/0009). This module
// is only the client-side contract: the type the route validates against, the
// human labels, and the one sentence that says WHY a row is here.
//
// That sentence is not decoration. An alert a user cannot evaluate at a glance
// is an alert they dismiss, and a feed of dismissed alerts is worse than no feed
// because it looks like coverage.
// ---------------------------------------------------------------------------

export const ALERT_KINDS = ["large_charge", "monthly_spike", "duplicate"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const SEVERITIES = ["high", "medium"] as const;
export type AlertSeverity = (typeof SEVERITIES)[number];

export type Alert = {
  kind: AlertKind;
  severity: AlertSeverity;
  facility: string;
  /** "YYYY-MM" */
  posted_period: string;
  /** "YYYY-MM-DD", or null for a whole-month finding. */
  txn_date: string | null;
  person: string;
  vendor: string | null;
  account_label: string | null;
  kpi_group: string | null;
  /** The charge, the month total, or the duplicated amount. */
  amount: number;
  /** Rows involved: 1 for a single charge, the duplicate count otherwise. */
  n: number;
  /** The norm this was measured against. */
  baseline: number | null;
  /** Dollars beyond the norm — the one figure comparable across all three rules. */
  excess: number;
};

export const ALERT_LABEL: Record<AlertKind, string> = {
  large_charge: "Unusually large charge",
  monthly_spike: "Monthly spend spike",
  duplicate: "Possible duplicate",
};

/** What the rule actually tests, shown as help text so a reviewer can judge the
 *  finding rather than trust it. */
export const ALERT_RULE: Record<AlertKind, string> = {
  large_charge:
    "At least 10x this person's median charge and at least $2,500, for cardholders with 12 or more charges.",
  monthly_spike:
    "A month at least double this person's average of every prior month at this facility, and at least $1,000 above it.",
  duplicate:
    "Two or more identical charges — same person, day, merchant and amount — at $100 or more, excluding amounts that recur on three or more days (those are subscriptions and budget caps, not double charges).",
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  high: "High",
  medium: "Medium",
};

/* Severity is also carried as text on every row. Colour alone would leave the
   distinction invisible to a red/green colour-blind reviewer, and this is a
   screen where the whole point is triage. */
export const SEVERITY_TAG: Record<AlertSeverity, string> = {
  high: "tag tag-danger",
  medium: "tag tag-warn",
};

/** One sentence saying why this row is in the feed, in the reviewer's terms. */
export function alertReason(a: Alert): string {
  switch (a.kind) {
    case "large_charge": {
      const x = a.baseline && a.baseline > 0 ? Math.round(a.amount / a.baseline) : null;
      return x
        ? `${usd(a.amount)} — about ${x}x this cardholder's typical ${usd(a.baseline!)} charge.`
        : `${usd(a.amount)} on a single charge.`;
    }
    case "monthly_spike":
      return `${usd(a.amount)} this month against a ${usd(a.baseline ?? 0)} average of every prior month — ${usd(a.excess)} above it.`;
    case "duplicate":
      return `${a.n} identical ${usd(a.amount)} charges to ${a.vendor ?? "the same merchant"} on one day — ${usd(a.excess)} of it may be a double charge.`;
  }
}

export type AlertFilter = {
  facility?: string | null;
  /** "YYYY-MM" */
  month?: string | null;
  kind?: AlertKind | null;
  person?: string | null;
};

/* "All" is what the shell's facility/month selects and the feed's kind segmented
   control carry when nothing is picked. `person` is not one of those — it is a
   literal name — so it is matched exactly; a cardholder recorded as "All" must
   not silently match everyone. */
const unset = (v: string | null | undefined) => !v || v === "All";

export function filterAlerts(alerts: Alert[], f: AlertFilter): Alert[] {
  return alerts.filter(
    (a) =>
      (unset(f.facility) || a.facility === f.facility) &&
      (unset(f.month) || a.posted_period === f.month) &&
      (unset(f.kind) || a.kind === f.kind) &&
      (f.person == null || a.person === f.person),
  );
}

/**
 * Runtime validation of one row from /api/alerts.
 *
 * The response is external data, so it is checked rather than cast — a bad row
 * is dropped, not rendered as `undefined` inside a currency string. Returns null
 * for anything that does not match, and the caller filters those out.
 */
export function parseAlert(raw: unknown): Alert | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const kind = o.kind;
  if (typeof kind !== "string" || !(ALERT_KINDS as readonly string[]).includes(kind)) return null;
  const severity = o.severity;
  if (typeof severity !== "string" || !(SEVERITIES as readonly string[]).includes(severity)) return null;
  if (typeof o.facility !== "string" || typeof o.person !== "string") return null;

  const amount = Number(o.amount);
  const excess = Number(o.excess);
  const n = Number(o.n);
  if (!Number.isFinite(amount) || !Number.isFinite(excess) || !Number.isFinite(n)) return null;

  // posted_period arrives as a DATE ("2026-07-01"); the UI keys on "YYYY-MM".
  const period = typeof o.posted_period === "string" ? o.posted_period.slice(0, 7) : "";
  if (!/^\d{4}-\d{2}$/.test(period)) return null;

  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown) => {
    const x = Number(v);
    return v === null || v === undefined || !Number.isFinite(x) ? null : x;
  };

  return {
    kind: kind as AlertKind,
    severity: severity as AlertSeverity,
    facility: o.facility,
    posted_period: period,
    txn_date: str(o.txn_date),
    person: o.person,
    vendor: str(o.vendor),
    account_label: str(o.account_label),
    kpi_group: str(o.kpi_group),
    amount,
    n: Math.trunc(n),
    baseline: num(o.baseline),
    excess,
  };
}
