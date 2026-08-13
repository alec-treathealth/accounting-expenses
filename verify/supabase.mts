// Shared read-only Supabase access for the verification scripts.
//
// Every check here reads with the SERVICE ROLE key, for two reasons: migration
// 0005 moved the aggregates behind "authenticated AND on the invite list", so the
// publishable key can no longer read them; and fact_txn has RLS on with zero
// policies, so the raw rows these checks compare against are reachable no other
// way. Nothing in this module writes.

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function envFromFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [".env.local", ".env"]) {
    const p = join(REPO, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const fileEnv = envFromFile();
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;

export function requireCreds(): { url: string; key: string } {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)");
    process.exit(2);
  }
  return { url: SUPABASE_URL, key: SERVICE_KEY };
}

const headers = () => {
  const { key } = requireCreds();
  return { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" };
};

export async function rest<T = any>(path: string): Promise<T[]> {
  const { url } = requireCreds();
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T[];
}

/**
 * Page a table to completion.
 *
 * TWO THINGS HERE ARE NOT OPTIONAL, and both were learned by getting them wrong:
 *
 * 1. STEP BY WHAT CAME BACK, and stop only on an EMPTY page. PostgREST enforces
 *    a server-side `db-max-rows` (1000 on this project), so asking for 5000 and
 *    treating "fewer than 5000 returned" as the end silently truncated every
 *    read to its first 1000 rows — which made the checks compare a 24,226-row
 *    aggregate against an 804-row sample and report six false failures.
 *
 * 2. `path` MUST CARRY AN ORDER. Offset paging over an unordered relation is
 *    undefined: Postgres may return a row twice and skip another, so an exactly-
 *    equal total would drift for no reason the check could explain.
 */
export async function restAll<T = any>(path: string, pageSize = 1000): Promise<T[]> {
  const { url } = requireCreds();
  if (!/[?&]order=/.test(path)) throw new Error(`restAll needs an explicit order= for stable paging: ${path}`);
  const out: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let offset = 0; ; ) {
    const res = await fetch(`${url}/rest/v1/${path}${sep}limit=${pageSize}&offset=${offset}`, {
      headers: headers(),
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
    const page = (await res.json()) as T[];
    if (page.length === 0) return out;
    out.push(...page);
    offset += page.length;
    if (out.length > 500_000) throw new Error(`restAll: refusing to page past 500k rows on ${path}`);
  }
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const { url } = requireCreds();
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`RPC ${fn} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T[];
}

/** Integer cents. Money comparisons must never be done in floating point — the
 *  whole point of these checks is exact equality, and 0.1 + 0.2 is not 0.3. */
export const cents = (v: unknown) => Math.round(Number(v) * 100);
export const money = (c: number) => `$${(c / 100).toFixed(2)}`;
