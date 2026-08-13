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
  whoLabel,
  type Alert,
  type AlertKind,
} from "@/lib/alerts";
import { useWarehouse } from "@/components/WarehouseProvider";
import { SkRows } from "@/components/Skeleton";
import Icon from "@/components/Icon";

/* Ramp charges that sit outside the cardholder's own norm, and the shared list
 * of the ones someone decided to look into.
 *
 * Every row states the rule that produced it in plain language, because an alert
 * a reviewer cannot evaluate at a glance is an alert they dismiss — and a feed of
 * dismissed alerts is worse than no feed, since it looks like coverage.
 *
 * READ IS PERSONAL, PINNED IS SHARED. Clearing your badge is your business;
 * flagging a charge for investigation is the team's. Read alerts stay in the
 * list, muted and sorted last — hiding them would destroy the audit trail, which
 * is the opposite of what a review screen is for.
 */
export default function AlertsFeed() {
  const { data, got, facility, month, openDrill, read, pins, setRead, setPinned } = useWarehouse();
  const [kind, setKind] = useState<AlertKind | "All">("All");

  const inScope = useMemo(
    () => filterAlerts(data.alerts, { facility, month }),
    [data.alerts, facility, month],
  );

  const unreadCount = useMemo(() => inScope.filter((a) => !read.has(a.key)).length, [inScope, read]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: inScope.length };
    for (const k of ALERT_KINDS) c[k] = 0;
    for (const a of inScope) c[a.kind]++;
    return c;
  }, [inScope]);

  /* Unread first, then the server's excess ordering within each half. A stable
     sort keeps that second key, so marking one alert read moves it to the bottom
     without reshuffling anything else. */
  const shown = useMemo(() => {
    const list = kind === "All" ? inScope : inScope.filter((a) => a.kind === kind);
    return [...list].sort((a, b) => Number(read.has(a.key)) - Number(read.has(b.key)));
  }, [inScope, kind, read]);

  const pinnedKeys = useMemo(() => new Set(pins.map((p) => p.key)), [pins]);
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
      <div className="alert-head">
        <p className="page-note" style={{ margin: 0 }}>
          {got.alerts ? (
            <>
              <b>{unreadCount}</b> of {inScope.length} charge{inScope.length === 1 ? "" : "s"} still to review in this
              view{exposure > 0 && <> · {usd(exposure)} beyond the expected amount</>}. These are prompts to look, not
              findings of error.
            </>
          ) : (
            "Checking Ramp charges against each cardholder’s own history…"
          )}
        </p>
        <button
          className="btn btn-secondary btn-sm"
          disabled={!got.alerts || unreadCount === 0}
          onClick={() => setRead(inScope.filter((a) => !read.has(a.key)).map((a) => a.key), true)}
        >
          Mark all as read{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </button>
      </div>

      <div className="alert-cols">
        <div className="alert-main-col">
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
              {shown.map((a) => {
                const isRead = read.has(a.key);
                const isPinned = pinnedKeys.has(a.key);
                return (
                  <li key={a.key} data-read={isRead ? "true" : undefined}>
                    <div className="alert-row">
                      {/* The row opens the drawer; pin and read are separate
                          controls. Nesting them inside one button would be
                          invalid HTML and unreachable by keyboard. */}
                      <button type="button" className="alert-main" onClick={() => open(a)}>
                        <span className="alert-top">
                          <span className={SEVERITY_TAG[a.severity]}>{SEVERITY_LABEL[a.severity]}</span>
                          <span className="alert-kind">{ALERT_LABEL[a.kind]}</span>
                          <span className="alert-who">{a.person}</span>
                          {isRead && <span className="tag tag-neutral">Read</span>}
                        </span>
                        <span className="alert-why">{alertReason(a)}</span>
                        <span className="alert-where">
                          {a.facility} · {MONTH_LABEL[a.posted_period] ?? monthName(a.posted_period)}
                          {a.txn_date && <> · {a.txn_date}</>}
                          {a.account_label && <> · {a.account_label}</>}
                        </span>
                      </button>

                      <div className="alert-side">
                        <span className="alert-amt">
                          {usd(a.amount)}
                          <span className="alert-amt-sub">{usd(a.excess)} over</span>
                        </span>
                        <div className="alert-acts">
                          <button
                            type="button"
                            className={"btn btn-sm " + (isPinned ? "btn-primary" : "btn-secondary")}
                            aria-pressed={isPinned}
                            onClick={() => setPinned(a, !isPinned)}
                            title={isPinned ? "Remove from the investigation list" : "Pin this charge to investigate"}
                          >
                            {isPinned ? "Pinned" : "Pin to investigate"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setRead([a.key], !isRead)}
                          >
                            {isRead ? "Unread" : "Read"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
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
        </div>

        <aside className="card pin-list" aria-labelledby="pins-h">
          <div className="pin-head">
            <h2 id="pins-h">Charge Investigation List</h2>
            <span className="pin-count">{pins.length}</span>
          </div>
          <p className="fine" style={{ marginTop: 0 }}>
            Shared with everyone on the dashboard. Anyone can add or clear an item.
          </p>

          {pins.length === 0 ? (
            <p className="empty-note">
              Nothing pinned. Use <b>Pin to investigate</b> on any alert and it lands here.
            </p>
          ) : (
            <ul className="pin-items">
              {pins.map((p) => {
                /* A pin holds a SNAPSHOT, so it survives the underlying charge
                   being corrected upstream. Say so when the live feed no longer
                   contains it, rather than showing a stale figure as current. */
                const stillLive = data.alerts.some((a) => a.key === p.key);
                return (
                  <li key={p.key}>
                    <div className="pin-item">
                      <button type="button" className="pin-open" onClick={() => open(p)}>
                        <span className="pin-top">
                          <span className={SEVERITY_TAG[p.severity]}>{SEVERITY_LABEL[p.severity]}</span>
                          <span className="pin-amt">{usd(p.amount)}</span>
                        </span>
                        <span className="pin-who">{p.person}</span>
                        <span className="pin-meta">
                          {p.facility} · {MONTH_LABEL[p.posted_period] ?? monthName(p.posted_period)}
                          {p.txn_date && <> · {p.txn_date}</>}
                        </span>
                        <span className="pin-meta">{ALERT_LABEL[p.kind]}</span>
                        {p.pinned_by && <span className="pin-meta">Pinned by {whoLabel(p.pinned_by)}</span>}
                        {got.alerts && !stillLive && (
                          <span className="pin-stale">No longer in the current feed — kept for the record.</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm pin-remove"
                        onClick={() => setPinned(p, false)}
                        aria-label={`Remove ${p.person} ${usd(p.amount)} from the investigation list`}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}
