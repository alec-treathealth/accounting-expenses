"use client";

import { useMemo, useState } from "react";
import { usd, MONTH_LABEL, monthName } from "@/lib/format";
import {
  ALERT_KINDS,
  ALERT_LABEL,
  ALERT_RULE,
  SEVERITY_LABEL,
  SEVERITY_TAG,
  alertReason,
  filterAlerts,
  type Alert,
  type AlertKind,
} from "@/lib/alerts";
import { useWarehouse } from "@/components/WarehouseProvider";
import { SkRows } from "@/components/Skeleton";

/* Ramp charges that sit outside the cardholder's own norm.
 *
 * Every row states the rule that produced it in plain language, because an alert
 * a reviewer cannot evaluate at a glance is an alert they dismiss — and a feed of
 * dismissed alerts is worse than no feed, since it looks like coverage.
 *
 * There is no dismiss button. Dismissal is durable per-user state and a real
 * feature; a button that only forgets until reload would be a lie about what the
 * system remembers.
 */
export default function AlertsFeed() {
  const { data, got, facility, month, openDrill } = useWarehouse();
  const [kind, setKind] = useState<AlertKind | "All">("All");

  const inScope = useMemo(
    () => filterAlerts(data.alerts, { facility, month }),
    [data.alerts, facility, month],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: inScope.length };
    for (const k of ALERT_KINDS) c[k] = 0;
    for (const a of inScope) c[a.kind]++;
    return c;
  }, [inScope]);

  const shown = useMemo(
    () => (kind === "All" ? inScope : inScope.filter((a) => a.kind === kind)),
    [inScope, kind],
  );

  const exposure = shown.reduce((s, a) => s + a.excess, 0);

  const open = (a: Alert) =>
    openDrill({
      title: `${a.person} · ${MONTH_LABEL[a.posted_period] ?? monthName(a.posted_period)}`,
      filters: {
        person: a.person,
        facility: a.facility,
        month: a.posted_period,
        ...(a.account_label ? { account_label: a.account_label } : {}),
      },
      /* No expected figure: an alert describes ONE charge or one duplicate pair,
         while the drill returns the cardholder's whole month. Handing the drawer
         a figure it cannot match would fire "does not reconcile" on data that is
         perfectly fine, which is exactly how a reconciliation warning stops
         meaning anything. */
      expected: null,
    });

  return (
    <>
      <p className="page-note">
        {got.alerts ? (
          <>
            <b>{inScope.length}</b> charge{inScope.length === 1 ? "" : "s"} outside the cardholder&rsquo;s own
            norm in this view{exposure > 0 && <> · {usd(exposure)} beyond the expected amount</>}. These are
            prompts to look, not findings of error.
          </>
        ) : (
          "Checking Ramp charges against each cardholder’s own history…"
        )}
      </p>

      <div className="seg alert-filter" role="radiogroup" aria-label="Alert type">
        {(["All", ...ALERT_KINDS] as const).map((k) => (
          <label key={k} className="seg-opt">
            <input type="radio" name="ths-alert-kind" checked={kind === k} onChange={() => setKind(k)} />
            {k === "All" ? "All" : ALERT_LABEL[k]}
            <span className="seg-count">{counts[k] ?? 0}</span>
          </label>
        ))}
      </div>

      <section className="card">
        {!got.alerts && <SkRows n={8} />}

        {got.alerts && shown.length === 0 && (
          <p className="empty-note">
            Nothing outside the norm here. Widen the facility or month filter to look further.
          </p>
        )}

        <ul className="alert-list">
          {shown.map((a, i) => (
            <li key={`${a.kind}:${a.person}:${a.facility}:${a.txn_date ?? a.posted_period}:${a.amount}:${i}`}>
              <button type="button" className="alert-row" onClick={() => open(a)}>
                <span className="alert-main">
                  <span className="alert-top">
                    <span className={SEVERITY_TAG[a.severity]}>{SEVERITY_LABEL[a.severity]}</span>
                    <span className="alert-kind">{ALERT_LABEL[a.kind]}</span>
                    <span className="alert-who">{a.person}</span>
                  </span>
                  <span className="alert-why">{alertReason(a)}</span>
                  <span className="alert-where">
                    {a.facility} · {MONTH_LABEL[a.posted_period] ?? monthName(a.posted_period)}
                    {a.txn_date && <> · {a.txn_date}</>}
                    {a.account_label && <> · {a.account_label}</>}
                  </span>
                </span>
                <span className="alert-amt">
                  {usd(a.amount)}
                  <span className="alert-amt-sub">{usd(a.excess)} over</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <details className="card rules">
        <summary>How these are detected</summary>
        <dl>
          {ALERT_KINDS.map((k) => (
            <div key={k}>
              <dt>{ALERT_LABEL[k]}</dt>
              <dd>{ALERT_RULE[k]}</dd>
            </div>
          ))}
        </dl>
        <p className="fine">
          Every rule is measured against the cardholder&rsquo;s <em>own</em> history rather than a single
          company-wide threshold: $900 is unremarkable for someone whose typical charge is $500 and
          extraordinary for someone whose typical charge is $18. Credits and refunds are excluded — a refund
          is not overspending.
        </p>
      </details>
    </>
  );
}
