import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { authorizeTxnRequest } from "@/lib/txnAuth";
import { getAuthorizedUser } from "@/lib/supabaseServerAuth";
import { parseAlert, parsePin, type Alert, type Pin } from "@/lib/alerts";

// Out-of-the-norm Ramp charges, plus the read state and investigation list that
// hang off them.
//
// The rules live in public.ramp_alerts() (supabase/migrations/0009, 0012). That
// function returns TRANSACTION-GRAIN rows — a date, a merchant, an amount and a
// named person — the same class of data as fact_txn, which has had RLS on with
// zero policies since 0001 and is reachable only with the service_role key. So
// this route sits behind the SAME gate as /api/txn rather than the tables being
// browser-readable. Sharing authorizeTxnRequest is the point: one door, one
// policy, no second implementation to drift.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const NO_STORE = { "cache-control": "no-store" } as const;

/** An alert_key is an md5 digest. Anything else never reaches a query. */
const KEY_RE = /^[0-9a-f]{32}$/;
/** Ceiling on a mark-all-read batch. The whole feed is ~139 rows; this is a
 *  bound on an unbounded input, not a product limit. */
const MAX_KEYS = 2000;

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: code, message }, { status, headers: NO_STORE });
}

/** Both verbs need the same two things: authorization and the caller's email. */
async function gate(req: NextRequest) {
  const auth = await authorizeTxnRequest(req, async () => (await getAuthorizedUser()) !== null);
  if (!auth.ok) return { error: fail(auth.status, auth.code, auth.message) };

  const user = await getAuthorizedUser();
  // Read state and pin attribution are keyed by email, so a session without one
  // cannot act. Lower-cased because app_access is matched case-insensitively and
  // the two must agree or a user's own read state would be invisible to them.
  if (!user?.email) return { error: fail(403, "no_email", "This account has no email address.") };

  try {
    return { db: supabaseAdmin(), email: user.email.toLowerCase() };
  } catch {
    return { error: fail(503, "not_configured", "Expense alerts are not configured on this deployment.") };
  }
}

/** The live feed. The single source of truth for which keys exist. */
async function loadAlerts(db: ReturnType<typeof supabaseAdmin>): Promise<{ alerts: Alert[]; dropped: number }> {
  const { data, error } = await db.rpc("ramp_alerts");
  if (error) throw new Error(error.message);
  const raw = Array.isArray(data) ? data : [];
  const alerts: Alert[] = [];
  for (const row of raw) {
    const a = parseAlert(row);
    if (a) alerts.push(a);
  }
  return { alerts, dropped: raw.length - alerts.length };
}

export async function GET(req: NextRequest) {
  const g = await gate(req);
  if ("error" in g) return g.error;
  const { db, email } = g;

  try {
    /* The three reads are independent, so they are issued together. The feed is
       the slowest (percentile_cont over 24,226 rows, ~0.6s); waiting for the two
       tiny table reads afterwards would add round trips for nothing. */
    const [feed, readRes, pinRes] = await Promise.all([
      loadAlerts(db),
      db.from("alert_read").select("alert_key").eq("email", email).limit(5000),
      db.from("alert_pin").select("*").order("pinned_at", { ascending: false }).limit(500),
    ]);
    if (readRes.error) throw new Error(readRes.error.message);
    if (pinRes.error) throw new Error(pinRes.error.message);

    if (feed.dropped > 0) console.warn(`[api/alerts] dropped ${feed.dropped} malformed alert row(s)`);

    const pins: Pin[] = [];
    for (const row of pinRes.data ?? []) {
      const p = parsePin(row);
      if (p) pins.push(p);
    }

    return NextResponse.json(
      {
        alerts: feed.alerts,
        read: (readRes.data ?? []).map((r) => String(r.alert_key)),
        pins,
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    console.error("[api/alerts] read failed:", e instanceof Error ? e.message : "unknown error");
    return fail(500, "read_failed", "Could not compute expense alerts.");
  }
}

/**
 * Actions: mark read, mark unread, pin, unpin.
 *
 * A pin stores a SNAPSHOT of the charge, and that snapshot is taken from the
 * server's own freshly-computed feed — never from the request body. The client
 * sends a key and nothing else, so it cannot write a person, an amount or a
 * facility of its own choosing into a table the team then investigates. Same
 * reason a key that is not currently in the feed is rejected rather than stored.
 */
export async function POST(req: NextRequest) {
  const g = await gate(req);
  if ("error" in g) return g.error;
  const { db, email } = g;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "bad_body", "Expected a JSON body.");
  }
  if (typeof body !== "object" || body === null) return fail(400, "bad_body", "Expected a JSON object.");
  const b = body as Record<string, unknown>;

  const action = b.action;
  if (action !== "read" && action !== "unread" && action !== "pin" && action !== "unpin")
    return fail(400, "bad_action", "action must be read, unread, pin or unpin.");

  const rawKeys = action === "read" || action === "unread" ? b.keys : [b.key];
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) return fail(400, "bad_keys", "No alert supplied.");
  if (rawKeys.length > MAX_KEYS) return fail(400, "too_many_keys", `At most ${MAX_KEYS} alerts at a time.`);
  const keys = [...new Set(rawKeys.map(String))];
  if (!keys.every((k) => KEY_RE.test(k))) return fail(400, "bad_keys", "Malformed alert identifier.");

  try {
    if (action === "read") {
      const rows = keys.map((alert_key) => ({ email, alert_key }));
      // Idempotent: marking an already-read alert read again must not error.
      const { error } = await db.from("alert_read").upsert(rows, { onConflict: "email,alert_key" });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, read: keys.length }, { headers: NO_STORE });
    }

    if (action === "unread") {
      const { error } = await db.from("alert_read").delete().eq("email", email).in("alert_key", keys);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, unread: keys.length }, { headers: NO_STORE });
    }

    if (action === "unpin") {
      // No email predicate: the investigation list is shared, so anyone may
      // clear an item. A worklist only its author can clear stops being cleared.
      const { error } = await db.from("alert_pin").delete().in("alert_key", keys);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, unpinned: keys.length }, { headers: NO_STORE });
    }

    // pin
    const { alerts } = await loadAlerts(db);
    const found = alerts.find((a) => a.key === keys[0]);
    if (!found) return fail(404, "unknown_alert", "That alert is no longer in the feed.");

    const { error } = await db.from("alert_pin").upsert(
      {
        alert_key: found.key,
        pinned_by: email,
        kind: found.kind,
        severity: found.severity,
        facility: found.facility,
        // The table column is a DATE; the feed carries "YYYY-MM".
        posted_period: `${found.posted_period}-01`,
        txn_date: found.txn_date,
        person: found.person,
        vendor: found.vendor,
        account_label: found.account_label,
        kpi_group: found.kpi_group,
        amount: found.amount,
        n: found.n,
        baseline: found.baseline,
        excess: found.excess,
      },
      { onConflict: "alert_key" },
    );
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, pinned: found.key }, { headers: NO_STORE });
  } catch (e) {
    console.error("[api/alerts] action failed:", e instanceof Error ? e.message : "unknown error");
    return fail(500, "action_failed", "Could not save that change.");
  }
}
