// x.ai / Grok usage probe. Two paths, tried in order, both wrapped — never throws:
//
//   PATH A (best-effort, zero-config): the grok CLI's local access JWT
//     (~/.grok/auth.json .key, scope grok-cli:access api:access) carries a `tier` claim
//     and the CLI's own /usage routes through an internal RPC (check_subscription) at
//     cli-chat-proxy.grok.com. We try that RPC; if it 404s / errors we fall back to the
//     tier claim already inside the JWT. UNDOCUMENTED — every step is try/catch, the JWT
//     is short-lived (~6h, the CLI rotates it) and we never refresh or persist it.
//
//   PATH B (reliable, one-time paste): if a Management API key was pasted (xai-connect),
//     read prepaid credits + postpaid spend from management-api.x.ai for the team_id that
//     lives in the same auth.json entry. Host/path/auth confirmed live 2026-06-10.
//
// Secrets (the JWT, the management key) NEVER enter the returned value, errors, or logs.

import { config } from './config.js';
import { readJson } from './util.js';
import { loadXaiMgmtKey } from './xai-connect.js';

const RPC_TIMEOUT_MS = 6_000;
const MGMT_TIMEOUT_MS = 8_000;
const MGMT_BASE = 'https://management-api.x.ai/v1';
const CLI_PROXY_BASE = 'https://cli-chat-proxy.grok.com';
const CONNECT_HINT =
  'paste an x.ai Management API key (console.x.ai -> Settings -> Management Keys) to see credits';

// ---------- result shape (contract for the subs collector) ----------

export type XaiUsage =
  | {
      source: 'internal' | 'mgmt';
      credits?: number; // prepaid balance, USD
      spend?: number; // postpaid spend so far this cycle, USD
      limit?: number; // effective spending limit, USD
      tier?: string;
      detail: string;
    }
  | { error: string; hint: string };

// ---------- grok auth.json (the CLI owns this; we only read) ----------

interface GrokEntry {
  key?: string;
  team_id?: string;
  expires_at?: string;
}

/**
 * auth.json is keyed by an opaque `https://auth.x.ai::<uuid>` string, so find the entry
 * structurally (has a string key + team_id) rather than hardcoding it. Prefer an entry
 * whose access token has not expired; fall back to the first usable one.
 */
async function readGrokEntry(): Promise<GrokEntry | null> {
  const auth = await readJson<Record<string, unknown>>(config.paths.grokAuth);
  if (!auth || typeof auth !== 'object') return null;
  let fallback: GrokEntry | null = null;
  for (const v of Object.values(auth)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as GrokEntry;
    if (typeof e.key !== 'string' || !e.key) continue;
    fallback ??= e;
    const exp = e.expires_at ? new Date(e.expires_at).getTime() : NaN;
    if (!Number.isFinite(exp) || exp > Date.now()) return e; // unexpired (or no expiry) wins
  }
  return fallback;
}

/** Decode a JWT payload without verifying — we only read non-secret claims (tier). */
function jwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------- PATH A: internal token (RPC, then local tier claim) ----------

/**
 * Best-effort hit of the CLI's internal subscription RPC. Undocumented and known to 404
 * for some accounts — any non-2xx / parse failure resolves to null so the caller falls
 * through to the JWT tier claim. The bearer is the local access JWT, never logged.
 */
async function tryCheckSubscription(jwt: string): Promise<{ tier?: string; detail?: string } | null> {
  try {
    const res = await fetch(`${CLI_PROXY_BASE}/auth/check_subscription`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: any = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return null;
    const tier =
      typeof body.tier === 'string'
        ? body.tier
        : typeof body.subscription === 'string'
          ? body.subscription
          : typeof body.subscriptionTier === 'string'
            ? body.subscriptionTier
            : undefined;
    const active = body.active ?? body.subscribed ?? body.is_subscribed;
    const detail =
      tier != null
        ? `x.ai ${tier}`
        : active === true
          ? 'x.ai subscription active'
          : undefined;
    if (tier == null && detail == null) return null; // nothing usable
    return { tier, detail };
  } catch {
    return null;
  }
}

async function pathInternal(entry: GrokEntry): Promise<XaiUsage | null> {
  const jwt = entry.key;
  if (!jwt) return null;

  const rpc = await tryCheckSubscription(jwt);
  if (rpc && (rpc.tier != null || rpc.detail != null)) {
    return {
      source: 'internal',
      tier: rpc.tier,
      detail: rpc.detail ?? (rpc.tier ? `x.ai ${rpc.tier}` : 'x.ai subscription active'),
    };
  }

  // RPC gave nothing usable — read the tier claim already inside the local JWT.
  const claims = jwtClaims(jwt);
  const tier = claims && typeof claims.tier === 'string' && claims.tier ? claims.tier : null;
  if (tier) {
    return { source: 'internal', tier, detail: `x.ai tier ${tier}` };
  }
  return null; // no usable internal signal — caller tries PATH B
}

// ---------- PATH B: management API (prepaid credits + postpaid spend) ----------

/** USD-cents -> USD. The balance/invoice amounts are integer cents (`val`). */
function centsToUsd(cents: unknown): number | undefined {
  const n = Number(cents);
  return Number.isFinite(n) ? Math.round(n) / 100 : undefined;
}

async function mgmtGet(path: string, key: string): Promise<any | null> {
  try {
    const res = await fetch(`${MGMT_BASE}${path}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(MGMT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

async function pathMgmt(entry: GrokEntry | null, key: string): Promise<XaiUsage> {
  const team = entry?.team_id;
  if (!team) {
    return {
      error: 'x.ai management key set but no team_id in ~/.grok/auth.json — open grok once to refresh it',
      hint: CONNECT_HINT,
    };
  }

  const [balance, invoice] = await Promise.all([
    mgmtGet(`/billing/teams/${encodeURIComponent(team)}/prepaid/balance`, key),
    mgmtGet(`/billing/teams/${encodeURIComponent(team)}/postpaid/invoice/preview`, key),
  ]);

  if (!balance && !invoice) {
    // both failed — most likely the key is invalid/revoked, or both endpoints are down
    return {
      error: 'x.ai management API rejected the key or is unreachable',
      hint: CONNECT_HINT,
    };
  }

  const credits = centsToUsd(balance?.total?.val);
  const spend = centsToUsd(invoice?.coreInvoice?.amountAfterVat);
  const limit = centsToUsd(invoice?.effectiveSpendingLimit);

  const parts: string[] = [];
  if (credits != null) parts.push(`$${credits.toFixed(2)} prepaid credits`);
  if (spend != null) parts.push(`$${spend.toFixed(2)} spent`);
  if (limit != null) parts.push(`of $${limit.toFixed(2)} limit`);

  if (credits == null && spend == null) {
    return {
      error: 'x.ai management API returned no balance or invoice figures',
      hint: CONNECT_HINT,
    };
  }

  return {
    source: 'mgmt',
    credits,
    spend,
    limit,
    detail: parts.join(' · ') || 'x.ai billing',
  };
}

// ---------- entry point ----------

/**
 * Resolve x.ai usage. Order: PATH A (internal token tier) if it yields something usable;
 * else PATH B (management key) when a key was pasted; else a hint to paste one. Never
 * throws — the subs collector treats { error, hint } as "active, show the hint".
 */
export async function getXaiUsage(): Promise<XaiUsage> {
  const entry = await readGrokEntry();

  // PATH A — zero-config, best-effort.
  if (entry) {
    try {
      const internal = await pathInternal(entry);
      if (internal) return internal;
    } catch {
      /* PATH A is never fatal — fall through to PATH B */
    }
  }

  // PATH B — only if the owner pasted a management key.
  const mgmtKey = await loadXaiMgmtKey();
  if (mgmtKey) {
    try {
      return await pathMgmt(entry, mgmtKey);
    } catch {
      return { error: 'x.ai usage lookup failed', hint: CONNECT_HINT };
    }
  }

  return { error: 'no x.ai usage available', hint: CONNECT_HINT };
}
