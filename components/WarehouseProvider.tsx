"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { parseAlert, parsePin, type Alert, type Pin } from "@/lib/alerts";
import { excludeRampCardholders, onlyExcludedRampCardholders, type RampPersonRow, type RampVendorRow } from "@/lib/ramp";
import type { DrillContext, DrillFilters } from "@/components/TxnDrawer";

/* ---------------------------------------------------------------------------
   One warehouse read per session, shared by every route.

   The App Router keeps this provider mounted across navigation, so moving
   between Dashboard, Intelligence, Compare and Alerts costs zero round trips
   and the facility/month filters survive the move — which is what makes the
   alert badge mean "in what I am currently looking at".

   DATASETS ARE FETCHED ON DEMAND, not all at once. Measured payloads:

       agg_group_month   58 kB     agg_ramp_person  146 kB
       agg_vendor       117 kB     agg_ramp_vendor  113 kB
       agg_account       13 kB     ramp_alerts       44 kB
       dim_facility     2.7 kB

   Loading everything on every page meant Compare and Alerts each pulling ~230 kB
   of vendor and account detail they never render. So gm/dim/alerts load at mount
   (the filter lists and the nav badge need them everywhere) and the rest are
   requested by the page that actually uses them, once, and then cached.
--------------------------------------------------------------------------- */

export type GM = {
  facility: string;
  /** "YYYY-MM" */
  posted_period: string;
  kpi_group: string;
  amount: number;
  n: number;
};
export type AA = {
  account_label: string;
  account_num: string | null;
  kpi_group: string;
  kind: string;
  amount: number;
  n: number;
};
export type AV = { facility: string; vendor: string; kpi_group: string; amount: number; n: number };
export type FAC = {
  facility: string;
  entity_raw: string;
  in_scope: boolean;
  in_export: boolean;
  note: string | null;
  /** Licensed bed capacity. NULL means no bed count is on file — see 0014. */
  beds: number | null;
};

export type DatasetKey = "gm" | "dim" | "alerts" | "aa" | "av" | "ramp" | "rampVendor";

/** Always loaded: every route needs the filter lists and the nav badge. */
const EAGER: DatasetKey[] = ["gm", "dim", "alerts"];

type Data = {
  gm: GM[];
  dim: FAC[];
  alerts: Alert[];
  aa: AA[];
  av: AV[];
  ramp: RampPersonRow[];
  rampVendor: RampVendorRow[];
};

const EMPTY: Data = { gm: [], dim: [], alerts: [], aa: [], av: [], ramp: [], rampVendor: [] };

type Ctx = {
  data: Data;
  /** Per-dataset arrival. A panel renders the moment ITS data lands. */
  got: Record<DatasetKey, boolean>;
  loadError: string | null;
  /** Ask for datasets this route needs. Idempotent; safe to call every render. */
  request: (keys: DatasetKey[]) => void;
  reload: () => void;

  /** Global filters, shared by every route. */
  facility: string;
  setFacility: (v: string) => void;
  month: string;
  setMonth: (v: string) => void;
  facilities: string[];
  months: string[];
  /** Facilities in scope per dim_facility, whether or not they spent anything. */
  rosterCount: number;

  /** Alert keys THIS user has marked read. Personal — it drives their badge. */
  read: Set<string>;
  /** The shared investigation list, newest first. */
  pins: Pin[];
  /** Mark read / unread. Optimistic, and rolled back if the write fails. */
  setRead: (keys: string[], value: boolean) => void;
  /** Pin / unpin. The server takes its own snapshot; the client sends a key. */
  setPinned: (alert: Alert, value: boolean) => void;

  openDrill: (ctx: DrillContext) => void;
  /** Cardholder the Card Spend page should preselect on arrival, and
   *  the setter the drill-down uses to hand one over before navigating. */
  focusPerson: string | null;
  setFocusPerson: (person: string | null) => void;
  /** Drill with the current facility/month filters folded in. */
  scope: () => DrillFilters;
  /** The agg_group_month figure for a filter, so a drawer can reconcile to it. */
  aggFor: (f: DrillFilters) => { amount: number; n: number };

  /* What the shared exec/admin card filter removed, as a TOTAL and never as
     rows. A scalar cannot be accidentally summed into a figure or rendered as a
     cardholder; it exists only so the Card Spend page can disclose the size of
     what it is not showing, which is what makes its own total reconcilable
     against agg_ramp_person. Unscoped by facility/month on purpose: it is a
     property of the filter, not of the current view. */
  rampWithheld: { amount: number; n: number; people: number };

  /** ISO timestamp of the newest ingest_log row — when the warehouse last
   *  changed. Null until the read lands (or if no ingest was ever logged). */
  updatedAt: string | null;
};

const WarehouseCtx = createContext<Ctx | null>(null);

export function useWarehouse(): Ctx {
  const ctx = useContext(WarehouseCtx);
  if (!ctx) throw new Error("useWarehouse must be used inside <WarehouseProvider>");
  return ctx;
}

/** Declare a route's data needs. Stable across renders via the joined key. */
export function useDatasets(keys: DatasetKey[]): void {
  const { request } = useWarehouse();
  const key = keys.join(",");
  useEffect(() => {
    request(key.split(",") as DatasetKey[]);
  }, [key, request]);
}

const num = (v: unknown) => Number(v);

export default function WarehouseProvider({
  children,
  drill,
}: {
  children: React.ReactNode;
  /** Renders the open drawer. Passed in so this module stays data-only. */
  drill: (ctx: DrillContext | null, close: () => void) => React.ReactNode;
}) {
  const [data, setData] = useState<Data>(EMPTY);
  const [got, setGot] = useState<Record<DatasetKey, boolean>>({
    gm: false, dim: false, alerts: false, aa: false, av: false, ramp: false, rampVendor: false,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [facility, setFacility] = useState("All");
  const [month, setMonth] = useState("All");
  const [drillCtx, setDrillCtx] = useState<DrillContext | null>(null);

  /* Alert read state and the investigation list arrive with the feed, in the
     same response, so the badge is never briefly wrong while a second request
     is in flight. */
  const [read, setReadState] = useState<Set<string>>(() => new Set());
  const [pins, setPins] = useState<Pin[]>([]);
  const [rampWithheld, setRampWithheld] = useState({ amount: 0, n: 0, people: 0 });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  /* Requested-set in a ref, tick in state. The ref is the source of truth (so a
     second request for the same dataset is a no-op with no render), and the tick
     is only there to wake the effect when the set actually grows. */
  const wanted = useRef<Set<DatasetKey>>(new Set(EAGER));
  const inflight = useRef<Set<DatasetKey>>(new Set());
  const [tick, setTick] = useState(0);

  const request = useCallback((keys: DatasetKey[]) => {
    let grew = false;
    for (const k of keys) {
      if (!wanted.current.has(k)) {
        wanted.current.add(k);
        grew = true;
      }
    }
    if (grew) setTick((t) => t + 1);
  }, []);

  /* A load is invalidated by UNMOUNT or by a RELOAD, never by the effect simply
     re-running.
     ---------------------------------------------------------------------------
     The obvious `let alive = true` + cleanup pattern is WRONG here and would have
     broken the first paint of every page. On mount, a page's useDatasets effect
     runs BEFORE the provider's (React runs child effects first), so it calls
     request() and bumps `tick`. The provider's effect then runs once, starts all
     the reads, and is IMMEDIATELY re-run by that tick change — whose cleanup
     would flip `alive` to false and make every one of those in-flight reads
     discard its result on arrival. Because the keys are already in `inflight`,
     nothing would retry them, and the dashboard would sit on skeletons forever.

     A generation counter separates the two cases: only reload() invalidates. */
  const mounted = useRef(true);
  const generation = useRef(0);
  /* RE-ARMED ON MOUNT, not just cleared on unmount. React 18 StrictMode (on via
     next.config.mjs) simulates an unmount+remount in development while
     PRESERVING refs, so a cleanup-only effect leaves mounted.current false for
     the rest of the session — live() then rejects every read that lands and all
     four pages sit on skeletons forever, with reload() unable to recover because
     it gates on the same flag. Production is unaffected (the double-invoke is
     dev-only), which is exactly why it survived: it never showed up in a build. */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    generation.current += 1;
    inflight.current.clear();
    setGot({ gm: false, dim: false, alerts: false, aa: false, av: false, ramp: false, rampVendor: false });
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const sb = getSupabaseBrowser();
    const gen = generation.current;
    const live = () => mounted.current && generation.current === gen;

    const fail = (what: string) => (e: unknown) => {
      if (!live()) return;
      // Generic to the user, specific in the console: the message can carry
      // PostgREST detail that must not be rendered into the page.
      console.error(`[warehouse] ${what} read failed`, e);
      setLoadError("Could not load some figures. Refresh to retry.");
      // Drop it from in-flight so a later reload() can retry rather than
      // treating a failed read as one that is still on its way.
      inflight.current.delete(what as DatasetKey);
    };

    const land = <K extends DatasetKey>(key: K, rows: Data[K]) => {
      if (!live()) return;
      setData((d) => ({ ...d, [key]: rows }));
      setGot((g) => ({ ...g, [key]: true }));
    };

    const table = <K extends DatasetKey>(
      key: K,
      name: string,
      limit: number,
      map: (r: any) => Data[K][number],
      /** Optional read-layer projection, applied after `map`. */
      refine?: (rows: Data[K]) => Data[K],
      /** Primary-key columns. REQUIRED for paging: see below. */
      order: string[] = [],
    ) => {
      /* PAGED, because `.limit(n)` DOES NOT DO WHAT IT LOOKS LIKE. PostgREST
         caps every response at db-max-rows, which is 1000 on this project, and
         it does so SILENTLY — no error, no truncation flag, just a short array.
         `.limit(5000)` on agg_ramp_person (1,516 rows) returned 1,000, so the
         Card Spend tab was rendering roughly $2.98M of a real $4.21M, and
         agg_vendor (4,232 rows) lost three quarters of its merchants including
         the second-largest one org-wide. Every figure downstream was quietly
         understated. Verified against the live project with a raw REST call.

         An explicit total order is not optional: without one, Postgres may
         return rows in any order per request, so page 2 can repeat or skip rows
         from page 1. Order on the primary key, which is unique by definition. */
      const PAGE = 1000;
      const acc: any[] = [];
      const step = (from: number) => {
        let q = sb.from(name).select("*");
        for (const c of order) q = q.order(c, { ascending: true });
        q.range(from, from + PAGE - 1).then(({ data: rows, error }) => {
          if (!live()) return;
          if (error) return fail(key)(error);
          const batch = (rows ?? []) as any[];
          acc.push(...batch);
          /* STEP BY WHAT CAME BACK, AND STOP ONLY ON AN EMPTY PAGE — the same
             rule as restAll() in verify/supabase.mts. Stopping on a SHORT page
             re-introduces exactly the bug being fixed: it assumes the server
             gives you as many rows as you asked for, which is the assumption
             db-max-rows violates. If that cap were ever lowered below PAGE,
             a short-page test would silently truncate again. */
          if (batch.length && acc.length < limit) return step(from + batch.length);
          /* The ceiling is a runaway guard, not a quota. Reaching it means the
             table outgrew what this screen was designed to hold, and landing a
             truncated dataset silently is the failure mode this whole change
             exists to remove — so it is an error, not a partial render. */
          if (batch.length && acc.length >= limit) {
            return fail(key)(new Error(
              `${name} exceeded the ${limit}-row ceiling for a browser read; it needs a server-side aggregate.`,
            ));
          }
          const mapped = acc.map(map) as Data[K];
          land(key, refine ? refine(mapped) : mapped);
        }, fail(key));
      };
      step(0);
    };

    const loaders: Record<DatasetKey, () => void> = {
      // posted_period arrives as a DATE; every consumer keys on "YYYY-MM".
      gm: () => table("gm", "agg_group_month", 50000, (r) => ({
        ...r, posted_period: String(r.posted_period).slice(0, 7), amount: num(r.amount),
      }), undefined, ["facility", "posted_period", "kpi_group"]),
      dim: () => table("dim", "dim_facility", 1000, (r) => r as FAC, undefined, ["facility"]),
      aa: () => table("aa", "agg_account", 20000, (r) => ({ ...r, amount: num(r.amount) }), undefined, ["account_label"]),
      av: () => table("av", "agg_vendor", 50000, (r) => ({ ...r, amount: num(r.amount) }), undefined, ["facility", "vendor", "kpi_group"]),
      /* The two Ramp datasets are filtered HERE, at the read, and nowhere else.
         agg_ramp_vendor feeds only the Card Spend tab. agg_ramp_person also
         reaches AppShell's drill-down, whose cardholder set decides whether a
         description renders as a link on EVERY tab — correct fall-out, since a
         link to a person this tab will not show would be a dead end, but worth
         knowing before relying on "only that tab". Nothing else reads either. Filtering per-consumer instead would let the cardholder
         list and the merchant drilldown disagree; filtering the warehouse
         tables would remove real spend from the Dashboard. See
         EXCLUDED_RAMP_CARDHOLDERS in lib/ramp.ts for why these six.

         Applied after the map so `person` is already its final shape, and via
         the shared helper so agg_ramp_person and agg_ramp_vendor cannot drift. */
      ramp: () => table("ramp", "agg_ramp_person", 50000, (r) => ({
        ...r, posted_period: String(r.posted_period).slice(0, 7), amount: num(r.amount),
      }), (rows) => {
        // Tally what is being dropped, here, where both sides are in hand — the
        // only place the two can be guaranteed to describe the same read.
        const dropped = onlyExcludedRampCardholders(rows);
        setRampWithheld({
          amount: Math.round(dropped.reduce((s, r) => s + r.amount, 0) * 100) / 100,
          n: dropped.reduce((s, r) => s + Number(r.n), 0),
          people: new Set(dropped.map((r) => r.person)).size,
        });
        return excludeRampCardholders(rows);
      }, ["facility", "posted_period", "person", "kpi_group"]),
      rampVendor: () => table("rampVendor", "agg_ramp_vendor", 50000, (r) => ({
        ...r, amount: num(r.amount), n: num(r.n), rk: num(r.rk),
      }), excludeRampCardholders, ["facility", "person", "vendor"]),
      /* Alerts are transaction grain, so they come from the server route rather
         than a table — fact_txn is not browser-readable and must not become so. */
      alerts: () => {
        fetch("/api/alerts", { credentials: "same-origin", headers: { accept: "application/json" } })
          .then(async (res) => {
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error((body && (body.message || body.error)) || res.statusText);
            if (!live()) return;
            const rows = Array.isArray(body?.alerts) ? body.alerts : [];
            setReadState(new Set(Array.isArray(body?.read) ? body.read.map(String) : []));
            setPins((Array.isArray(body?.pins) ? body.pins : []).map(parsePin).filter(Boolean) as Pin[]);
            land("alerts", rows.map(parseAlert).filter(Boolean) as Alert[]);
          })
          .catch(fail("alerts"));
      },
    };

    /* Iterate a SNAPSHOT of the wanted set. Mutating a Set while a for..of walks
       it is legal in JS but the new entries would be visited by this pass and by
       the pass the tick triggers, and only `inflight` would stop the double
       fetch — relying on that is a trap for whoever edits this next. */
    for (const key of [...wanted.current]) {
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      loaders[key]();
    }
  }, [tick, reloadKey]);

  /* The freshness tag's source of truth: the newest ingest_log row, stamped by
     the ingest route after every successful rebuild. Its own effect, keyed on
     reloadKey alone — the loaders' effect refires on every dataset request
     (tick), which would re-read a value that only changes when data lands. Not
     a DatasetKey either: nothing renders rows from it, and a failure must not
     raise the load-error banner over figures that loaded fine — the top bar
     simply shows no tag. reload() after an upload refetches it with the rest. */
  useEffect(() => {
    let cancelled = false;
    getSupabaseBrowser()
      .from("ingest_log")
      .select("uploaded_at")
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .then(({ data: rows, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[warehouse] ingest_log read failed", error);
          return;
        }
        setUpdatedAt(rows?.[0]?.uploaded_at ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // --- derived filter lists -------------------------------------------------

  // dim_facility is the roster; agg_group_month only holds facilities that spent
  // something. A facility with no expense accounts in the export must still be
  // offered in the picker, so the list cannot come from the aggregates alone.
  const inScope = useMemo(() => data.dim.filter((d) => d.in_scope), [data.dim]);

  const facilities = useMemo(() => {
    const s = new Set(data.gm.map((r) => r.facility));
    inScope.forEach((d) => s.add(d.facility));
    return [...s].sort();
  }, [data.gm, inScope]);

  /* Derived from the data, never hardcoded. A hardcoded month list is how the
     dashboard previously ended up able to show a month the warehouse did not
     have — and to hide one it did. */
  const months = useMemo(
    () => [...new Set(data.gm.map((r) => r.posted_period))].sort(),
    [data.gm],
  );

  // --- drill-down -----------------------------------------------------------

  // --- alert actions --------------------------------------------------------

  /* Optimistic, with a real rollback. Marking 139 alerts read must feel
     instantaneous, and a round trip before the badge clears would make the
     button feel broken. But an optimistic update that silently keeps a failed
     change on screen is worse than a slow one — the user would believe the
     server has state it does not — so a rejected write puts the previous value
     back and says so. */
  const post = useCallback(async (payload: Record<string, unknown>, rollback: () => void) => {
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch (e) {
      console.error("[warehouse] alert action failed", e);
      rollback();
      setLoadError("That change could not be saved. Refresh and try again.");
    }
  }, []);

  const setRead = useCallback(
    (keys: string[], value: boolean) => {
      if (!keys.length) return;
      const before = read;
      const next = new Set(before);
      for (const k of keys) (value ? next.add(k) : next.delete(k));
      setReadState(next);
      void post({ action: value ? "read" : "unread", keys }, () => setReadState(before));
    },
    [read, post],
  );

  const setPinned = useCallback(
    (alert: Alert, value: boolean) => {
      const before = pins;
      setPins(
        value
          ? [
              // Provisional row so the list updates at once. The server writes
              // its OWN snapshot from the live feed, and the next load replaces
              // this with that — the client never authors pinned figures.
              { ...alert, pinned_by: "", pinned_at: new Date().toISOString() },
              ...before.filter((p) => p.key !== alert.key),
            ]
          : before.filter((p) => p.key !== alert.key),
      );
      void post({ action: value ? "pin" : "unpin", key: alert.key }, () => setPins(before));
    },
    [pins, post],
  );

  const [focusPerson, setFocusPerson] = useState<string | null>(null);

  /* Opening a drill also asks for the Ramp roster, because the drawer offers a
     link from a cardholder's name into Card Spend and can only do that
     for names the warehouse knows. Requested here rather than eagerly: it is
     146 kB that a user who never drills should not pay for. */
  const openDrill = useCallback(
    (ctx: DrillContext) => {
      request(["ramp"]);
      setDrillCtx(ctx);
    },
    [request],
  );

  /* Stable, not an inline arrow at the call site. TxnDrawer keys its focus and
     body-scroll effect on `onClose`, so a fresh identity on every provider
     render tears that effect down and re-runs it — which restores focus to the
     element that opened the drawer and then moves it to the close button. A
     dataset landing while someone is typing in the drawer's search box would
     lose their caret mid-word, and the next space would press Close. */
  const closeDrill = useCallback(() => setDrillCtx(null), []);

  const scope = useCallback(
    (): DrillFilters => ({
      ...(facility === "All" ? {} : { facility }),
      ...(month === "All" ? {} : { month }),
    }),
    [facility, month],
  );

  const aggFor = useCallback(
    (f: DrillFilters) => {
      let amount = 0;
      let n = 0;
      for (const r of data.gm) {
        if (f.facility && r.facility !== f.facility) continue;
        if (f.month && r.posted_period !== f.month) continue;
        if (f.kpi_group && r.kpi_group !== f.kpi_group) continue;
        amount += r.amount;
        n += r.n;
      }
      return { amount: Math.round(amount * 100) / 100, n };
    },
    [data.gm],
  );

  const value = useMemo<Ctx>(
    () => ({
      data, got, loadError, request, reload,
      facility, setFacility, month, setMonth,
      facilities, months,
      rosterCount: inScope.length || facilities.length,
      read, pins, setRead, setPinned,
      openDrill, focusPerson, setFocusPerson, scope, aggFor, rampWithheld, updatedAt,
    }),
    [data, got, loadError, request, reload, facility, month, facilities, months, inScope.length,
     read, pins, setRead, setPinned, openDrill, focusPerson, scope, aggFor, rampWithheld, updatedAt],
  );

  return (
    <WarehouseCtx.Provider value={value}>
      {children}
      {drill(drillCtx, closeDrill)}
    </WarehouseCtx.Provider>
  );
}
