# Expense Workspace — design

Turn the single-page dashboard into a four-section workspace behind an M3
navigation rail, and add the two things the page cannot express today: who spent
the money on a Ramp card, and which charges deserve a second look.

## Why this shape

The dashboard answers "how much, by what, where". It cannot answer "who", because
the only carrier of that fact — `fact_txn.description` — is transaction-grain and
never reaches the browser. Ramp is where "who" lives: **24,226 of the warehouse's
29,864 rows (81%) are Ramp charges**, worth **$4,154,179.85 of $22,851,611.16
(18%)**. Many rows, small dollars: exactly the population a card-spend review is
for, and exactly the population a monthly close never looks at.

Four sections, because four questions:

| Section | Question | Route |
| --- | --- | --- |
| Dashboard | How much did we spend, on what, where? | `/` |
| Expense Intelligence | Who spent it, and where did it go? | `/intelligence` |
| Compare | How does X compare with Y? | `/compare` |
| Expense Alerts | What looks wrong? | `/alerts` |

## Global constraints

- No hex may appear in `app/`, `components/` or `lib/`. Every value resolves to a
  design-system token. `grep -rE "#[0-9a-fA-F]{6}"` over those trees returns
  nothing (the sanctioned exception is `themeColor` in `app/layout.tsx`).
- Ramp spend is a **slice** of the existing KPI groups, never a ninth group. The
  grand total stays $22,851,611.16.
- Transaction-grain data reaches the browser only through an authenticated
  server route. Aggregates reach it through RLS-protected tables.
- Every figure on screen must be traceable to transactions that sum to it.
- Nothing new may be reachable by `anon`.

## Identity: what "a person" is

`description` on a Ramp row is either a bare cardholder name or
`"<name> - <memo>"`. The rule, fixed once in SQL as `public.ramp_person()`:

> take the text before the first ` - `, collapse internal whitespace, trim.

Measured against the live warehouse: **1,591 distinct raw descriptions collapse to
90 people.** It merges the duplicates that matter — `Patrick O'Connell` (127 rows)
with `Patrick O'Connell - Amazon order for office supplies.` (139 rows) — and
repairs `Joshua  luis`. Only **6 rows of 24,226** ($4,952.42) carry no
description; they become `(unattributed)` rather than disappearing, so the panel
still sums to the Ramp total.

No curated alias table. 90 names is small enough to eyeball, the residue is 0.02%
of rows, and a hand-maintained mapping is a second source of truth that silently
rots. If a real alias problem appears later, it earns its table then.

**`ramp_person()` is the single definition.** The aggregate, the alerts function
and the drill-down filter all call it, so the panel's figure and the drawer's rows
cannot drift apart by construction.

## Identifying a Ramp charge

`split` carries the other side of the transaction. Two spellings exist:
`2030 Ramp Card` (20,098 rows, $3,526,113.28, 13 facilities) and
`2030 Ramp Credit Card` (4,128 rows, $628,066.57, Hillside only). Folding them is
mandatory — otherwise Hillside's $628K reads as a separate card product.

`public.is_ramp_split()` matches `^2030[[:space:]]+ramp([[:space:]]|$)`.

> **Postgres trap, verified the hard way.** `\b` is **backspace** in a Postgres
> regex, not a word boundary — `split ~* '^2030\s+ramp\b'` matches **0 rows** where
> the POSIX form matches all 24,226. The word boundary is `\y`. The POSIX
> character class is used instead of either, because it cannot be misread.

The match is deliberately anchored on `2030`. `2020 Capital One Xxxx6456` is a
different card and stays out.

## Data layer

### `agg_ramp_person` — 1,493 rows

`(facility, posted_period, person, kpi_group, amount, n)`. Browser-readable under
the same RLS as the other aggregates: `authenticated` **and** on the `app_access`
invite list. This is a roll-up, not detail — it exposes no individual charge.

Carrying `kpi_group` is what makes "compare each person's spending habits"
possible without another round trip: a person's mix across the eight groups is
already in the rows the page has.

### `agg_ramp_vendor` — 1,396 rows

`(facility, person, vendor, amount, n, rk)`, top 12 merchants per
facility-and-person. Covers $3,715,544.89 of $4,154,179.85 (89%) in ~1,400 rows
instead of 4,459. The panel is labelled **Top 12 merchants** and prints the
covered share, because a truncated list that looks complete is a lie. Fetched
lazily when Expense Intelligence mounts — the Dashboard never pays for it.

### `rebuild_aggregates()` — extended, guard included

Both tables are filled in the same function that builds the others, and both get
the same treatment the existing three get: a tie-out that raises (rolling back the
whole rebuild) if the table does not equal a direct sum of its source slice.

### `ramp_alerts()` — server-only

`security definer`, granted to `service_role` only, reached through
`/api/alerts`. It returns transaction-grain rows, so it lives behind the same door
as `/api/txn` rather than in a browser-readable table. That is the boundary the
warehouse has held since 0005 and this feature does not get to weaken it.

## The alert rules

Thresholds were chosen by measuring alert volume against the live warehouse, not
guessed. Across the whole five-month window:

| Rule | Test | Fires |
| --- | --- | --- |
| **Large charge** | `amount >= 10 x that person's median` **and** `>= $2,500`, person has >= 12 charges | 92 |
| **Monthly spike** | person-month `>= 2x` their prior-month average **and** `+>= $1,000`, >= 2 prior months | 11 |
| **Possible duplicate** | same person, facility, day, merchant and amount, > 1 row, `>= $100`, **not routine** | 32 |

~135 alerts over five months, ~27 a month. Reviewable. A feed nobody can finish is
a feed nobody reads.

Each rule is per-person-relative rather than absolute, because a $900 charge is
unremarkable for the person whose median is $500 and extraordinary for the person
whose median is $18. The absolute floor sits underneath so a person with a $4
median does not generate an alert for a $40 lunch.

### Why "not routine" is load-bearing

The naive duplicate rule — same person, day, merchant, amount — fires **446 times**
at >= $250. **414 of those are `Google Ads` at exactly $500.00** against
`6010 PPC- Pay Per Click`: an ad-platform daily budget cap, charged repeatedly by
design. Shipping that rule would bury the 32 real findings under 414 false ones
and teach the user to ignore the badge within a day.

So a `(person, merchant, amount)` triple seen on **3 or more distinct days** is
recurring by definition and cannot raise a duplicate. That single clause takes the
rule from 446 findings to 128, and to 32 at the $100 floor — worth $27,362.18 in
potentially doubled charges.

Alerts are computed, never stored, and carry no dismissal state. Re-ingest
re-derives them; there is nothing to migrate and nothing to go stale. Dismissal is
a real feature with real state and it is not in scope.

## Navigation

An M3 navigation rail on the left: 240px expanded, 72px icon-only below 1100px,
and a top bar with an overflow menu below 760px. Each item is an icon, a label and
an optional badge. The active item takes a solid accent indicator — which
`components.css` names as one of exactly three places a solid accent fill is
allowed, alongside progress fills and chart series.

The alert badge sits on the Expense Alerts item and shows the count for the
current facility and month filters, so it answers "what needs review *in what I am
looking at*". It is `aria-label`ed in full ("Expense Alerts, 27 needing review")
because a bare number next to an icon is meaningless to a screen reader.

Icons are inline SVG in one module. No icon font, no CDN, nothing that a future
CSP would have to allow.

### Shared state across routes

Route changes must not refetch. A client `WarehouseProvider` in the shell holds
the aggregates, the loading flags, the facility/month filters and the drill-down
opener; the App Router preserves the layout across navigation, so moving between
sections costs nothing. Expense Intelligence's two tables load on first visit and
are then cached for the session.

## Expense Intelligence

Left: every cardholder ranked by spend, high to low, as a bar row — the same
component language as Spend by Facility, so the screen needs no new reading. It
respects the global facility and month filters.

Right: the selected person. Their total and share, their mix across the eight KPI
groups, their month-by-month trend, their top 12 merchants, and a button into the
transaction drawer filtered to exactly their Ramp charges.

Selecting more than one person switches the right pane to a comparison table —
people as columns, KPI groups as rows — which is what "compare the KPIs of each
person's spending habits" asks for. Capped at four columns; beyond that the table
stops being readable.

## Drill-down

`/api/txn` gains two filters, `ramp=1` and `person=<name>`, validated the same way
every other filter is: `person` against an allowlist built from
`agg_ramp_person`, so nothing user-supplied reaches PostgREST unbounded. Both are
mirrored into `txn_totals()` so the drawer's reconciliation still compares like
with like.

`ramp=1` alone does **not** satisfy the "at least one filter" rule — `?ramp=1`
would be a 24,226-row dump, which is the exact thing that rule exists to prevent.

## Fitting the page

- `.kpis` is `repeat(4, 1fr)` with three cards in it. Fixed to three.
- The shell owns page width; `.wrap`'s fixed 1120px max is replaced by a fluid
  content column so the rail does not squeeze the grids.
- Every table that can overflow gets its own `overflow-x: auto` container. The
  body never scrolls sideways.
- Bar-row label columns are already `overflow-wrap: anywhere`; person names are
  shorter than facility names, so no change is needed.

## Accessibility

- The rail is a `<nav>` of links, with `aria-current="page"` on the active item —
  not a listbox of buttons.
- One `<h1>` per route.
- Person selection is a real checkbox group, keyboard-operable, not click handlers
  on divs.
- Every clickable figure keeps the existing pattern: a `<button>` with an
  `aria-label` that states the value and the action.
- Alert severity is never colour alone; each row carries a text label.
- Focus is visible everywhere (`:focus-visible` is global in components.css).

## Verification

- `verify/ramp.mts` — asserts `agg_ramp_person` sums to the Ramp slice of
  `fact_txn` exactly, that person normalisation is idempotent, that both split
  spellings fold, that the Ramp total does **not** change the grand total, and
  that `agg_ramp_vendor` never exceeds its parent person total.
- `verify/alerts.mts` — asserts every rule's population against a direct query,
  and that the routine-recurrence exclusion removes the Google Ads block.
- `verify/txn-drilldown.mts` — extended for the two new filters.
- `npm run build` must pass with no new warnings.
