import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { getSessionUser } from "@/lib/supabaseServerAuth";
import { GROUP_ORDER } from "@/lib/format";

// Node runtime (not edge): this route uses the service_role key and node:crypto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// force-dynamic alone is NOT enough: it makes the ROUTE dynamic but still lets
// Next serve this handler's outbound PostgREST GETs from the Data Cache, so the
// fact_txn count and the aggregate total below can be read stale — including
// immediately after a rebuild, which would report the pre-rebuild figure and
// make a successful rebuild look like it did nothing. Verified reproducible on
// the sibling /api/txn route (see PR #6). Opt every fetch in this route out.
export const fetchCache = "force-no-store";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// AUTH GATE  --  needs sign-off, see the PR description.
//
// This route mutates the financial taxonomy (map_account_group) and can trigger
// a full rebuild of the aggregate tables the dashboard reads, so it must not be
// callable by an anonymous request. The app has no application-level auth and
// building a login/session system is out of scope, so the gate is a single
// shared secret in ADMIN_API_TOKEN (server-only env var, never NEXT_PUBLIC),
// sent by the browser in the x-admin-token header.
//
// It FAILS CLOSED at every step:
//   * ADMIN_API_TOKEN unset, or shorter than 24 chars -> 503, no mutation is
//     even attempted. Merging this PR therefore changes nothing in production
//     until that variable is deliberately added in Vercel.
//   * header missing or not equal to the token -> 401, no mutation.
//   * SUPABASE_SERVICE_ROLE_KEY unset -> 503 (this is what happens in local dev).
//
// What it protects against: an anonymous request to /api/mapping recategorising
// spend or rebuilding the aggregates; and, because the credential is a custom
// header rather than a cookie, CSRF (a cross-site page cannot set custom headers
// on a request the browser will send, and a preflight would be refused).
//
// What it does NOT protect against, and why it needs sign-off:
//   * No per-user identity, so no audit trail of WHO changed a mapping. The
//     taxonomy is small and reviewed by hand, but attribution is genuinely
//     absent.
//   * One shared secret for everyone: rotating it locks out every user, and
//     there is no per-user revocation.
//   * The token is typed into the browser and held in sessionStorage, so it is
//     exposed to anything that can run script on the page (an XSS bug, a
//     malicious extension).
//   * It is not a substitute for Vercel Deployment Protection (SSO), which is
//     still the boundary on the dashboard itself and on /admin's read-only
//     view. This adds a second, narrower boundary on the WRITE path only.
//   * No rate limiting: brute-force resistance rests entirely on token entropy,
//     hence the 24-char minimum. Use a random 32+ char secret.
// ---------------------------------------------------------------------------
const MIN_TOKEN_LEN = 24;

type Gate = { ok: true } | { ok: false; status: number; error: string };

function sha256(s: string) {
  return createHash("sha256").update(s, "utf8").digest();
}

function checkAuth(req: NextRequest): Gate {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LEN) {
    return {
      ok: false,
      status: 503,
      error:
        "Admin writes are disabled: ADMIN_API_TOKEN is not set on the server (or is shorter than " +
        MIN_TOKEN_LEN +
        " characters). Set it in the Vercel project environment to enable mapping edits.",
    };
  }
  const presented = req.headers.get("x-admin-token") || "";
  // Hash both sides first so the comparison is constant-time and does not leak
  // the token length through an early length check.
  if (!timingSafeEqual(sha256(presented), sha256(expected))) {
    return { ok: false, status: 401, error: "Unauthorized: missing or invalid admin token." };
  }
  return { ok: true };
}

// Whitelist of writable groups. Deliberately the same constant the dashboard
// renders from, so the two can never drift apart.
const VALID_GROUPS = new Set(GROUP_ORDER);

// A session is now NECESSARY for both reads and writes here. It is not
// SUFFICIENT for writes: checkAuth()/ADMIN_API_TOKEN still runs after this and
// remains the second factor on the destructive path.
function needsSession() {
  return NextResponse.json(
    { error: "unauthenticated", message: "Sign in to view or edit account mappings." },
    { status: 401 },
  );
}

function fail(g: Extract<Gate, { ok: false }>) {
  return NextResponse.json({ error: g.error }, { status: g.status });
}

// supabaseAdmin() throws when SUPABASE_SERVICE_ROLE_KEY is absent (local dev).
// Convert that into a 503 the UI can render, instead of an unhandled 500.
function admin() {
  try {
    return { sb: supabaseAdmin() };
  } catch {
    return {
      err: {
        ok: false as const,
        status: 503,
        error:
          "Server is not configured for writes: SUPABASE_SERVICE_ROLE_KEY is not set. " +
          "This is expected in local dev, where no service_role key is available.",
      },
    };
  }
}

// GET: gated status probe. Its only job is to report things the browser cannot
// read for itself -- fact_txn is private (RLS on, no anon policy), and its row
// count is what decides whether a rebuild would do anything at all.
export async function GET(req: NextRequest) {
  if (!(await getSessionUser())) return needsSession();

  const gate = checkAuth(req);
  if (!gate.ok) return fail(gate);

  const a = admin();
  if (a.err) return fail(a.err);

  const { count: factRows, error: fErr } = await a.sb
    .from("fact_txn")
    .select("row_key", { count: "exact", head: true });
  if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 });

  const { data: tot, error: tErr } = await a.sb.from("agg_group_month").select("amount");
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  const total = (tot || []).reduce((s: number, r: any) => s + Number(r.amount), 0);

  return NextResponse.json({
    ok: true,
    fact_rows: factRows ?? 0,
    agg_total: Math.round(total * 100) / 100,
  });
}

export async function POST(req: NextRequest) {
  if (!(await getSessionUser())) return needsSession();

  const gate = checkAuth(req);
  if (!gate.ok) return fail(gate);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  // `null`, a bare string and an array all parse as valid JSON; reject anything
  // that is not an object before reading fields off it.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }

  if (body.action !== "update" && body.action !== "rebuild") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  // --- update one mapping row --------------------------------------------
  if (body.action === "update") {
    // Validate the payload BEFORE constructing the privileged client, so a bad
    // request is rejected without any database access at all.
    const label = typeof body.account_label === "string" ? body.account_label : "";
    if (!label) return NextResponse.json({ error: "account_label is required" }, { status: 400 });

    const hasGroup = body.kpi_group !== undefined;
    const group = hasGroup ? String(body.kpi_group) : "";
    if (hasGroup && !VALID_GROUPS.has(group)) {
      return NextResponse.json(
        { error: `kpi_group must be one of: ${GROUP_ORDER.join(", ")}` },
        { status: 400 }
      );
    }
    if (body.reviewed !== undefined && typeof body.reviewed !== "boolean") {
      return NextResponse.json({ error: "reviewed must be a boolean" }, { status: 400 });
    }
    if (!hasGroup && body.reviewed === undefined) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const a = admin();
    if (a.err) return fail(a.err);
    const sb = a.sb;

    // The account_label must ALREADY exist in the taxonomy. This route only ever
    // updates; it can never insert an arbitrary account. New labels enter
    // map_account_group solely through rebuild_aggregates(), which seeds them
    // from real fact_txn rows (see 0003_rebuild_from_map.sql).
    const { data: existing, error: exErr } = await sb
      .from("map_account_group")
      .select("account_label,kpi_group,reviewed")
      .eq("account_label", label)
      .maybeSingle();
    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });
    if (!existing) {
      return NextResponse.json(
        { error: `unknown account_label: ${label}` },
        { status: 404 }
      );
    }

    // Setting a group counts as reviewing the account, unless the caller said
    // otherwise explicitly.
    const patch: Record<string, unknown> = {};
    if (hasGroup) patch.kpi_group = group;
    patch.reviewed = body.reviewed !== undefined ? body.reviewed : true;

    const { data, error } = await sb
      .from("map_account_group")
      .update(patch)
      .eq("account_label", label)
      .select("account_label,account_num,kpi_group,kind,reviewed")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Honest about consequences: the taxonomy is changed, but nothing the
    // dashboard reads moves until rebuild_aggregates() runs over a non-empty
    // fact_txn.
    return NextResponse.json({
      ok: true,
      row: data,
      previous: { kpi_group: existing.kpi_group, reviewed: existing.reviewed },
      note: "Taxonomy updated. Run a rebuild to push this into the dashboard aggregates.",
    });
  }

  // --- rebuild the aggregates from the taxonomy ---------------------------
  {
    const a = admin();
    if (a.err) return fail(a.err);
    const sb = a.sb;

    // Read the fact row count FIRST so we can tell the user honestly whether
    // the rebuild actually did anything. rebuild_aggregates() returns void and
    // no-ops on an empty fact_txn, so a bare "success" would be misleading.
    const { count: before, error: cErr } = await sb
      .from("fact_txn")
      .select("row_key", { count: "exact", head: true });
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    const factRows = before ?? 0;

    const { error: rbErr } = await sb.rpc("rebuild_aggregates");
    if (rbErr) return NextResponse.json({ error: rbErr.message }, { status: 500 });

    const { data: tot, error: tErr } = await sb.from("agg_group_month").select("amount");
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
    const total = (tot || []).reduce((s: number, r: any) => s + Number(r.amount), 0);

    return NextResponse.json({
      ok: true,
      fact_rows: factRows,
      no_op: factRows === 0,
      total: Math.round(total * 100) / 100,
    });
  }
}
