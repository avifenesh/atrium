// Client for the tiyuvta inference console's owner API.
//
// WHY THE OPERATOR UI LIVES HERE AND NOT THERE: the console is a public-facing Worker.
// Every admin page it served had to authenticate an owner in a browser and then hold
// the power to credit accounts, suspend them and run the books — on the internet. This
// daemon is loopback-only and holds the bearer locally, so the same operations move
// behind the machine boundary instead of behind a session cookie. The console keeps the
// API; atrium becomes the place it is driven from.
//
// The bearer is NOT copied into atrium's config. It is read from the file that already
// owns it (~/.config/tiyuvta/oauth.env, mode 600), so there is one copy of the secret
// on this machine and rotating it needs no change here.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

interface TiyuvtaConfig {
  baseUrl: string;
  tokenEnvPath: string;
  tokenEnvVar: string;
}

function settings(): TiyuvtaConfig {
  const raw = (config as unknown as { tiyuvta?: Partial<TiyuvtaConfig> }).tiyuvta ?? {};
  return {
    baseUrl: raw.baseUrl || 'https://inference.tiyuvta.ai',
    tokenEnvPath: raw.tokenEnvPath || join(homedir(), '.config/tiyuvta/oauth.env'),
    tokenEnvVar: raw.tokenEnvVar || 'OWNER_ADMIN_TOKEN',
  };
}

export class TiyuvtaUnconfigured extends Error {}

async function bearer(): Promise<string> {
  const { tokenEnvPath, tokenEnvVar } = settings();
  let text: string;
  try {
    text = await readFile(tokenEnvPath, 'utf8');
  } catch {
    throw new TiyuvtaUnconfigured(`no token file at ${tokenEnvPath}`);
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === tokenEnvVar) {
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      if (value) return value;
    }
  }
  throw new TiyuvtaUnconfigured(`${tokenEnvVar} not set in ${tokenEnvPath}`);
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { baseUrl } = settings();
  const token = await bearer();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // The console's own error shape is {error: {code, detail}}; surface the code,
    // because "engine_unreachable" and "unauthorized" want different reactions.
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; detail?: string } };
      if (parsed.error?.code) detail = `${parsed.error.code}${parsed.error.detail ? `: ${parsed.error.detail}` : ''}`;
    } catch {
      /* keep the raw body */
    }
    throw new Error(`${method} ${path} → ${response.status} ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface AdminDashboard {
  accounts: { total: number; enrolled: number; suspended: number; withPurchase: number; consented: number; internal?: number; newToday: number; new7d: number };
  money: {
    creditedMicro: number;
    purchasedMicro: number;
    grantedMicro: number;
    rebatedMicro: number;
    spentMicro: number;
    outstandingMicro: number;
    purchases?: number;
    pendingPurchases?: number;
  };
  /** External (customer) traffic only; the owner's own accounts report under `internal`. */
  totals: { requests: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number; debitedMicro: number };
  internal?: { totals: { requests: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number; debitedMicro: number } };
  promo: { claimed: number; seats: number; remaining: number };
  books: { outOfBalance: number; lastPassAt: number | null; restatedDays: number };
  top: Array<{ email: string; tenantId: string; creditedMicro: number; spentMicro: number; requests: number; paid: boolean; suspended: boolean; enrolled: boolean; internal?: boolean }>;
}

export interface AdminTraffic {
  configured: boolean;
  error: string | null;
  totals: { views: number; sites: number };
  pages: Array<Record<string, string | number | null>>;
  sources: Array<Record<string, string | number | null>>;
  clicks: Array<Record<string, string | number | null>>;
}

/** GET /admin/gads — Google Ads spend (pushed by the scheduled Ads Script) joined with the signup funnel per ref. */
export interface GadsReport {
  days: number;
  /** Epoch ms of the last ingest — how fresh the script's push is. Null before the first push. */
  updatedAt: number | null;
  spend: Array<{
    ref: string;
    costMicros: number;
    /** Account currency (ILS) — convert where read, never where stored. */
    currency: string | null;
    clicks: number;
    impressions: number;
    signups: number;
    activated: number;
    paid: number;
    usageMicro: number;
    lastSpendDay: string | null;
  }>;
  unspentRefs: Array<{ ref: string; signups: number; activated: number; paid: number; usageMicro: number }>;
}

/** GET /admin/activity — who was active when, on which box (owner order 2026-08-23).
 * Per-engine figures are fanned out live by the console because its D1 mirror stores
 * only the cross-box sum; `source`/`note` say so. Engines are one-model-per-box, so
 * `engines[]` also names each engine's box and model. Engine `totals` are CUSTOMER
 * traffic only; the owner's own accounts (bench key, watchdogs, probes) report under
 * `internalTotals` and carry `internal: true` on their tenant rows. */
export interface ActivityFigures {
  requests: number;
  totalTokens: number;
  debitedMicro: number;
}

export interface AdminActivity {
  days: number;
  source: string;
  note: string;
  generatedAt: number;
  engines: Array<{ engine: string; box: string; model: string; totals: ActivityFigures; internalTotals: ActivityFigures }>;
  tenants: Array<{
    tenantId: string;
    internal: boolean;
    lastActiveDay: string | null;
    totals: ActivityFigures;
    engines: Partial<Record<string, ActivityFigures>>;
    days: Array<{ day: string; engine: string } & ActivityFigures>;
  }>;
  errors: Array<{ tenantId: string; engine: string; code: string }>;
  truncated: boolean;
}

export const readDashboard = () => request<AdminDashboard>('GET', '/admin/dashboard');
export const readActivity = (days = 14) => request<AdminActivity>('GET', `/admin/activity?days=${days}`);
export const readGads = (days: 7 | 30 | 90 = 30) => request<GadsReport>('GET', `/admin/gads?days=${days}`);
export const readTraffic = (days = 7) => request<AdminTraffic>('GET', `/admin/traffic?days=${days}`);
export const readWebhookFailures = () => request<{ data: unknown[] }>('GET', '/admin/webhook-failures');
export const readCreditRequests = () => request<{ data: unknown[] }>('GET', '/admin/credit-requests');

/**
 * Which API surfaces the LIVE endpoint actually serves, and which models it lists.
 *
 * Probed without a key on purpose. Auth runs before body validation, so a route that
 * exists answers 401 and a route that does not answers 404 — which means presence is
 * measurable for zero tokens and zero credentials. The engine repo having a surface and
 * the serving box answering on it are different facts, and on 2026-08-17 they differed:
 * v0.90.0 shipped /v1/messages and /v1/responses while the box still 404'd both.
 */
export interface ApiSurfaces {
  base: string;
  surfaces: Array<{ path: string; state: 'present' | 'absent' | 'unknown'; status: number }>;
  models: string[];
}

export async function readApiSurfaces(apiBase = 'https://api.tiyuvta.ai/v1'): Promise<ApiSurfaces> {
  const paths = ['/chat/completions', '/completions', '/responses', '/messages', '/embeddings'];
  const surfaces = await Promise.all(
    paths.map(async (path) => {
      try {
        const response = await fetch(`${apiBase}${path}`, {
          method: 'POST',
          // x-tiyuvta-probe keeps these out of the router's real-user metrics
          // (tiyuvta_api). Unflagged, this check wrote a steady 4xx floor into
          // the dataset — every 5 minutes, four rejecting paths — which read
          // as a customer failing continuously during the 2026-08-23 outage
          // investigation until it was traced back here.
          headers: { 'content-type': 'application/json', 'x-tiyuvta-probe': '1' },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        });
        // Three states, not two. "Not 404" was wrong: during a deploy every path
        // answers 502, which made a restarting box look like it served everything —
        // including surfaces it has never had. A route that exists REJECTS a bad
        // request (400/401/422); one that does not exist says 404; anything else is
        // unknown and must not be reported as either.
        const { status } = response;
        const state: ApiSurfaces['surfaces'][number]['state'] =
          status === 404 ? 'absent' : status < 500 ? 'present' : 'unknown';
        return { path, state, status };
      } catch {
        return { path, state: 'unknown' as const, status: 0 };
      }
    }),
  );

  let models: string[] = [];
  try {
    const catalogue = (await (
      await fetch(`${apiBase}/models`, {
        headers: { 'x-tiyuvta-probe': '1' },
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as {
      data?: Array<{ id?: string }>;
    };
    models = (catalogue.data ?? []).map((entry) => entry.id ?? '').filter(Boolean);
  } catch {
    /* leave empty; the row says so */
  }

  return { base: apiBase, surfaces, models };
}

/**
 * Everything that can be TRIGGERED from here, by name. An allowlist rather than a
 * path passthrough: this daemon accepts loopback POSTs, and a passthrough would turn
 * any of them into "call any console admin endpoint".
 *
 * `needsTenant` actions take a tenant id from the request body and nothing else.
 */
export const ACTIONS = {
  'auto-topups': { method: 'POST', path: '/admin/auto-topups/run', label: 'Run auto top-ups' },
  'training-rebates': { method: 'POST', path: '/admin/training-rebates/run', label: 'Run training rebates' },
  accounting: { method: 'POST', path: '/admin/accounting/run', label: 'Run accounting pass' },
  enrolments: { method: 'POST', path: '/admin/enrolments/run', label: 'Repair stuck enrolments' },
  'alert-test': { method: 'POST', path: '/admin/alert-test', label: 'Send a test alert' },
  enroll: { method: 'POST', path: '/admin/accounts/{tenant}/enroll', label: 'Enroll with the engine', needsTenant: true },
  suspend: { method: 'POST', path: '/admin/accounts/{tenant}/suspend', label: 'Suspend account', needsTenant: true },
  restore: { method: 'POST', path: '/admin/accounts/{tenant}/restore', label: 'Restore account', needsTenant: true },
  // Owner-traffic labelling: the dashboard splits usage on this flag so bench and
  // smoke traffic stops reading as customer demand. No effect on keys or billing.
  'mark-internal': { method: 'POST', path: '/admin/accounts/{tenant}/mark-internal', label: 'Mark account as owner-internal', needsTenant: true },
  'mark-external': { method: 'POST', path: '/admin/accounts/{tenant}/mark-external', label: 'Unmark owner-internal account', needsTenant: true },
  // Owner credit through the console's idempotent /admin/grant (owner ask
  // 2026-08-31: the CRM actions board). Body, not path, so it is special-cased
  // in runAction below.
  grant: { method: 'POST', path: '/admin/grant', label: 'Grant owner credit', needsTenant: true },
} as const;

export type ActionName = keyof typeof ACTIONS;

/** The board's grant ceiling. A bigger grant is a deliberate act that belongs in
 *  a documented curl with the owner bearer, not one tap from a list row. */
const GRANT_MAX_MICRO = 50_000_000;

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

export async function runAction(
  name: ActionName,
  tenant?: string,
  opts?: { amountMicro?: number; reason?: string },
): Promise<unknown> {
  const action = ACTIONS[name];
  const needsTenant = 'needsTenant' in action && action.needsTenant;
  if (needsTenant && !tenant) throw new Error(`${name} needs a tenant id`);
  // Tenant ids are the console's own opaque ids; anything else is a path-injection
  // attempt, so it is rejected here rather than encoded and forwarded.
  if (tenant && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new Error(`bad tenant id ${tenant}`);
  if (name === 'grant') {
    const amountMicro = opts?.amountMicro;
    if (!Number.isSafeInteger(amountMicro) || amountMicro! <= 0 || amountMicro! > GRANT_MAX_MICRO) {
      throw new Error(`grant needs an integer amountMicro in (0, ${GRANT_MAX_MICRO}]`);
    }
    const reason = (opts?.reason ?? '').trim() || 'crm-board';
    if (reason.length > 120) throw new Error('grant reason too long');
    return request<unknown>('POST', action.path, {
      tenant_id: tenant,
      amount_micro: amountMicro,
      reason,
    });
  }
  const path = needsTenant ? action.path.replace('{tenant}', tenant!) : action.path;
  return request<unknown>('POST', path);
}
