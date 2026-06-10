// Cursor usage broker for the subs collector. Owner runs cursor-agent on this machine;
// reading his own spend/usage over loopback with his own bearer is a dashboard read,
// not a security event. Token is read fresh every call (cursor-agent rotates it),
// used only as an Authorization bearer / session cookie, and NEVER logged, returned,
// or otherwise allowed into the snapshot/SSE.
//
// Files (all owned by cursor-agent — we only read):
//   ~/.config/cursor/auth.json   — { accessToken, refreshToken } (0600, token rotates)
//   ~/.cursor/cli-config.json    — serverConfigCache.backendUrl + authInfo.{userId,authId}
//
// PRIMARY  POST {backendUrl}/aiserver.v1.DashboardService/GetCurrentPeriodUsage
//          headers: Authorization: Bearer <accessToken>, Connect-Protocol-Version: 1
// FALLBACK POST https://cursor.com/api/dashboard/get-current-period-usage
//          Cookie WorkosCursorSessionToken=<authId>::<accessToken> (the :: url-encoded),
//          plus Origin: https://cursor.com (without it the site answers 403 invalid-origin).
// Both return the same Connect JSON, so one mapper covers them. Plan name is enriched
// best-effort from /api/auth/stripe (membershipType); a failure there never breaks the card.
//
// Verified live 2026-06-10: primary 200, fallback 200 (with Origin), stripe 200.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './util.js';

const AUTH_PATH = join(homedir(), '.config', 'cursor', 'auth.json');
const CLI_CONFIG_PATH = join(homedir(), '.cursor', 'cli-config.json');
const DEFAULT_BACKEND = 'https://api2.cursor.sh';
const WEB_ORIGIN = 'https://cursor.com';
const TIMEOUT_MS = 8_000;

export interface CursorUsage {
  plan: string | null;
  periodStart: string | null; // ISO
  periodEnd: string | null; // ISO
  totalSpend: number; // USD
  limit: number; // USD; 0 means no spend cap configured
  percentUsed: number; // 0..100 of included usage
  breakdown?: { label: string; usedPct: number }[];
}

export type CursorUsageResult = CursorUsage | { error: string; hint: string };

/** Last successful read, held in module scope so a transient failure keeps the card warm. */
let lastGood: CursorUsage | null = null;

// ---------- local files (read fresh each call; token never retained) ----------

async function readAccessToken(): Promise<string | null> {
  const auth = await readJson<{ accessToken?: unknown }>(AUTH_PATH);
  const t = auth?.accessToken;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

async function readCliConfig(): Promise<{ backendUrl: string; authId: string | null }> {
  const cfg = await readJson<any>(CLI_CONFIG_PATH);
  const backend = cfg?.serverConfigCache?.backendUrl;
  const authId = cfg?.authInfo?.authId;
  return {
    backendUrl: typeof backend === 'string' && backend.startsWith('http') ? backend : DEFAULT_BACKEND,
    authId: typeof authId === 'string' && authId.length > 0 ? authId : null,
  };
}

// ---------- response mapping (shared by primary RPC + REST fallback) ----------

/** int64-as-string epoch MS (verified: billingCycleStart=1781120698087 → 2026-06-10) to ISO. */
function epochMsToIso(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // values are already milliseconds; guard a seconds-form fallback just in case
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clampPct(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/**
 * spendLimitUsage amounts are integer cents (per recon + community trackers). Divide to
 * dollars. Magnitude guard: a value that is already a small fractional dollar (non-integer)
 * is passed through, so a future API that switches to dollars won't be divided twice.
 */
function centsToUsd(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isInteger(n)) return Math.round(n * 100) / 100; // already dollars
  return Math.round(n) / 100;
}

/** Map the Connect JSON (camelCase) shared by both endpoints into CursorUsage. */
function mapUsage(body: any): CursorUsage | null {
  if (!body || typeof body !== 'object') return null;
  const plan = body.planUsage;
  const spend = body.spendLimitUsage;
  if (!plan || typeof plan !== 'object') return null;

  const limit = centsToUsd(spend?.overallLimit);
  const remaining = centsToUsd(spend?.overallRemaining);
  // spend = configured cap minus what's left; only meaningful when a cap exists
  const totalSpend = limit > 0 ? Math.max(0, Math.round((limit - remaining) * 100) / 100) : 0;

  const breakdown: { label: string; usedPct: number }[] = [];
  if (typeof plan.autoPercentUsed === 'number') breakdown.push({ label: 'auto', usedPct: clampPct(plan.autoPercentUsed) });
  if (typeof plan.apiPercentUsed === 'number') breakdown.push({ label: 'api', usedPct: clampPct(plan.apiPercentUsed) });

  return {
    plan: null, // RPC carries no plan name; enriched from stripe when reachable
    periodStart: epochMsToIso(body.billingCycleStart),
    periodEnd: epochMsToIso(body.billingCycleEnd),
    totalSpend,
    limit,
    percentUsed: clampPct(plan.totalPercentUsed),
    breakdown: breakdown.length > 0 ? breakdown : undefined,
  };
}

// ---------- network (token used only as a header/cookie, never emitted) ----------

async function fetchPrimary(backendUrl: string, accessToken: string): Promise<CursorUsage | null> {
  const res = await fetch(`${backendUrl}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`primary HTTP ${res.status}`);
  return mapUsage(await res.json());
}

async function fetchFallback(authId: string, accessToken: string): Promise<CursorUsage | null> {
  // WorkosCursorSessionToken = <authId>::<accessToken>, with :: url-encoded as %3A%3A
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${authId}::${accessToken}`)}`;
  const res = await fetch(`${WEB_ORIGIN}/api/dashboard/get-current-period-usage`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fallback HTTP ${res.status}`);
  return mapUsage(await res.json());
}

/** Best-effort plan name from the stripe endpoint. Never throws; null on any trouble. */
async function fetchPlanName(authId: string | null, accessToken: string): Promise<string | null> {
  if (!authId) return null;
  try {
    const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${authId}::${accessToken}`)}`;
    const res = await fetch(`${WEB_ORIGIN}/api/auth/stripe`, {
      method: 'GET',
      headers: { Cookie: cookie, Origin: WEB_ORIGIN },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const m = body?.membershipType ?? body?.individualMembershipType;
    return typeof m === 'string' && m.length > 0 ? m : null;
  } catch {
    return null;
  }
}

// ---------- public entry ----------

/**
 * Read cursor's current-period usage. Returns the mapped usage on success, or an
 * { error, hint } pair the caller can show as a calm one-liner. Holds the last-good
 * value so a transient failure never blanks the card. The bearer token never appears
 * in the return value, in errors, or in logs.
 */
export async function getCursorUsage(): Promise<CursorUsageResult> {
  const accessToken = await readAccessToken();
  if (!accessToken) {
    return { error: 'cursor-agent not logged in', hint: 'cursor-agent not logged in' };
  }
  const { backendUrl, authId } = await readCliConfig();

  let usage: CursorUsage | null = null;
  try {
    usage = await fetchPrimary(backendUrl, accessToken);
  } catch {
    // community notes report occasional 400s on the RPC — try the cookie REST form
    if (authId) {
      try {
        usage = await fetchFallback(authId, accessToken);
      } catch {
        usage = null;
      }
    }
  }

  if (!usage) {
    if (lastGood) return lastGood; // hold the warm card through a transient failure
    return { error: 'cursor usage unavailable', hint: 'cursor usage API unreachable right now' };
  }

  usage.plan = await fetchPlanName(authId, accessToken);
  lastGood = usage;
  return usage;
}
