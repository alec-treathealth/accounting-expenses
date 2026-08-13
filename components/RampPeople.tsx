"use client";

import { useMemo, useState } from "react";
import { usd, pct } from "@/lib/format";
import { filterRamp, rankPeople, share, total, UNATTRIBUTED } from "@/lib/ramp";
import { useDatasets, useWarehouse } from "@/components/WarehouseProvider";
import { SkRows } from "@/components/Skeleton";
import PersonDetail from "@/components/PersonDetail";
import PersonCompare from "@/components/PersonCompare";

/* Expense Intelligence: Ramp card spend, by the person who spent it.
 *
 * Left, every cardholder ranked high to low — the same bar-row language as Spend
 * by Facility, so the screen needs no new reading. Right, whatever the selection
 * asks for: the Ramp picture overall, one person in depth, or up to four side by
 * side.
 *
 * Selecting is a TOGGLE on the row itself rather than a separate checkbox
 * column. One affordance per row, and the row is already the thing you want to
 * press.
 */

/** Beyond four columns the comparison table stops being readable at a glance. */
const MAX_COMPARE = 4;

export default function RampPeople() {
  useDatasets(["ramp", "rampVendor"]);
  const { data, got, facility, month } = useWarehouse();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  // Everything below is scoped by the shell's global facility/month filters.
  const scoped = useMemo(
    () => filterRamp(data.ramp, { facility, month }),
    [data.ramp, facility, month],
  );

  const rampTotal = useMemo(() => total(scoped), [scoped]);

  /* Company spend in the same scope, so the Ramp share is a like-for-like
     fraction. This is the number that stops Ramp being read as new money: it is
     a SLICE of what the Dashboard already reports, not an addition to it. */
  const allTotal = useMemo(() => {
    let amount = 0;
    for (const r of data.gm) {
      if (facility !== "All" && r.facility !== facility) continue;
      if (month !== "All" && r.posted_period !== month) continue;
      amount += r.amount;
    }
    return Math.round(amount * 100) / 100;
  }, [data.gm, facility, month]);

  const people = useMemo(() => rankPeople(scoped), [scoped]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? people.filter((p) => p.person.toLowerCase().includes(q)) : people;
  }, [people, query]);

  const max = Math.max(...people.map((p) => Math.abs(p.amount)), 1);
  const atCap = selected.length >= MAX_COMPARE;

  const toggle = (person: string) =>
    setSelected((cur) =>
      cur.includes(person)
        ? cur.filter((p) => p !== person)
        : cur.length >= MAX_COMPARE
          ? cur
          : [...cur, person],
    );

  return (
    <>
      <p className="page-note">
        {usd(rampTotal.amount)} on {rampTotal.n.toLocaleString()} Ramp card charges across{" "}
        {people.length} cardholder{people.length === 1 ? "" : "s"}
        {allTotal > 0 && <> — {pct(rampTotal.amount / allTotal)} of all spend in this view</>}.{" "}
        <b>This is a slice of the Dashboard&rsquo;s total, not an addition to it.</b>
      </p>

      <div className="split">
        <section className="card people-list" aria-labelledby="people-h">
          <div className="people-head">
            <h2 id="people-h">Cardholders</h2>
            {selected.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected([])}>
                Clear {selected.length}
              </button>
            )}
          </div>

          <label className="sr-only" htmlFor="people-q">Find a cardholder</label>
          <input
            id="people-q"
            className="input people-search"
            type="search"
            placeholder="Find a cardholder…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <p className="fine" id="people-hint">
            Select up to {MAX_COMPARE} to compare their spending mix.
            {atCap && " Deselect one to choose another."}
          </p>

          {!got.ramp && <SkRows n={10} />}

          <div className="people-scroll">
            {shown.map((p) => {
              const on = selected.includes(p.person);
              const blocked = !on && atCap;
              return (
                <button
                  type="button"
                  key={p.person}
                  className="bar-row dd-trigger person-row"
                  aria-pressed={on}
                  aria-disabled={blocked || undefined}
                  aria-describedby="people-hint"
                  data-selected={on ? "true" : undefined}
                  onClick={() => !blocked && toggle(p.person)}
                  title={
                    p.person === UNATTRIBUTED
                      ? "Ramp charges whose description carries no cardholder name"
                      : `${p.person} — ${p.facilities.join(", ")}`
                  }
                >
                  <div className="bar-lab">{p.person}</div>
                  <div className="track">
                    <div
                      className="fill"
                      style={{ width: (Math.abs(p.amount) / max) * 100 + "%", background: "var(--seq)", opacity: on ? 1 : 0.8 }}
                    />
                  </div>
                  <div className="bar-val">
                    {usd(p.amount)} <span className="bar-sub">{share(p.amount, rampTotal.amount) ?? 0}%</span>
                  </div>
                </button>
              );
            })}
            {got.ramp && !shown.length && (
              <p className="empty-note">No cardholder matches “{query}”.</p>
            )}
          </div>
        </section>

        <section className="card person-pane" aria-live="polite">
          {selected.length === 0 && (
            <div className="person-empty">
              <h2>Ramp card spend</h2>
              <p>
                Every charge here also appears in the Dashboard&rsquo;s KPI groups — this page splits the
                same money by the person who spent it.
              </p>
              <p>
                <b>Select a cardholder</b> on the left to see their spending mix, their month-by-month trend
                and the merchants they used. Select two to four to compare them.
              </p>
              <dl className="stat-pair">
                <div>
                  <dt>Ramp spend in this view</dt>
                  <dd>{got.ramp ? usd(rampTotal.amount) : "…"}</dd>
                </div>
                <div>
                  <dt>Charges</dt>
                  <dd>{got.ramp ? rampTotal.n.toLocaleString() : "…"}</dd>
                </div>
                <div>
                  <dt>Cardholders</dt>
                  <dd>{got.ramp ? people.length : "…"}</dd>
                </div>
              </dl>
            </div>
          )}

          {selected.length === 1 && (
            <PersonDetail
              person={selected[0]}
              rows={scoped}
              vendors={data.rampVendor}
              rampTotal={rampTotal.amount}
            />
          )}

          {selected.length > 1 && <PersonCompare people={selected} rows={scoped} />}
        </section>
      </div>
    </>
  );
}
