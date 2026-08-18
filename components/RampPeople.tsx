"use client";

import { useEffect, useMemo, useState } from "react";
import { usd, pct } from "@/lib/format";
import { filterRamp, rankPeople, share, total, UNATTRIBUTED } from "@/lib/ramp";
import { useDatasets, useWarehouse } from "@/components/WarehouseProvider";
import { SkRows } from "@/components/Skeleton";
import PersonDetail from "@/components/PersonDetail";
import PersonCompare from "@/components/PersonCompare";

/* Card Spend: Ramp card spend, by the person who spent it.
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
  const { data, got, facility, month, focusPerson, setFocusPerson, rampWithheld } = useWarehouse();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  /* Arriving from a drill-down: the drawer handed over a cardholder before
     navigating here. Consumed once and cleared, so going Back or switching
     sections does not silently re-select them. */
  useEffect(() => {
    if (!focusPerson) return;
    setSelected([focusPerson]);
    setQuery("");
    setFocusPerson(null);
  }, [focusPerson, setFocusPerson]);

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

  /** True when nothing is filtered, i.e. when the page total and the company-wide
   *  withheld figure describe the same population and may be added. */
  const unfiltered = facility === "All" && month === "All";

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
      {/* agg_ramp_person is requested BY THIS PAGE, so every first visit paints
          before it lands. Without the gate this line reads "$0.00 on 0 Ramp card
          charges across 0 cardholders" — a statement of fact — while the panel
          beside it correctly shows "…". */}
      <p className="page-note">
        {got.ramp ? (
          <>
            {usd(rampTotal.amount)} on {rampTotal.n.toLocaleString()} Ramp card charges across{" "}
            {people.length} cardholder{people.length === 1 ? "" : "s"}
            {allTotal > 0 && <> — {pct(rampTotal.amount / allTotal)} of all spend in this view</>}.{" "}
          </>
        ) : (
          <>Loading Ramp card spend… </>
        )}
        <b>This is a slice of the Dashboard&rsquo;s total, not an addition to it.</b>
      </p>

      {/* THE WITHHELD FIGURE IS NAMED, not just the fact of withholding. These
          six cards are about half of all Ramp spend, so "excluded from the
          cardholder breakdown" read as though it applied to the LIST while the
          headline total above still covered everything. It does not: every
          figure on this tab is computed from the filtered rows. Printing the
          amount is what lets anyone add the two together and reconcile this
          page against agg_ramp_person, instead of finding a gap they cannot
          explain. */}
      <p className="fine">
        <b>Every figure on this page excludes six shared exec/admin cards</b> — the totals and shares
        above as well as the list below. They buy across many entities at once, so attributing their
        spend to one cardholder misreads it.
        {got.ramp && rampWithheld.amount > 0 && (
          <>
            {" "}
            {/* The withheld figure is company-wide, while the total above honours
                the facility/month pickers. Adding the two is only arithmetic when
                nothing is filtered — under a filter they describe different
                populations, and printing a sum of them would be precisely the
                mismatched-scope error this page is careful about elsewhere. */}
            {unfiltered ? (
              <>
                Withheld: <b>{usd(rampWithheld.amount)}</b> over {rampWithheld.n.toLocaleString()}{" "}
                charges on {rampWithheld.people} cards, so all Ramp spend is{" "}
                {usd(Math.round((rampTotal.amount + rampWithheld.amount) * 100) / 100)} before this
                page&rsquo;s filter.
              </>
            ) : (
              <>
                Withheld company-wide: <b>{usd(rampWithheld.amount)}</b> over{" "}
                {rampWithheld.n.toLocaleString()} charges on {rampWithheld.people} cards — a
                company-wide figure, not comparable with the filtered total above.
              </>
            )}
          </>
        )}{" "}
        That spend is still counted in the Dashboard and in every vendor, account and facility view,
        under their own names.
      </p>

      {/* Mounted unconditionally so its TEXT mutates rather than the node being
          inserted: a status region that appears with its content is announced
          wholesale, one that changes in place announces only the change. */}
      <p className="sr-only" role="status">
        {selected.length === 0
          ? "No cardholder selected"
          : selected.length === 1
            ? `Showing ${selected[0]}`
            : `Comparing ${selected.length} cardholders`}
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

        {/* Deliberately NOT aria-live. A live region around the whole pane
            queues every text node React inserts — the name, the meta line, one
            row per KPI group, five spark columns, twelve merchant rows and two
            paragraphs of fine print — several hundred uninterruptible words on
            every selection. The persistent status node below announces the one
            fact that changed instead. */}
        <section className="card person-pane">
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
