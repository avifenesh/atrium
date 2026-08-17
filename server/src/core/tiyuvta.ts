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
  accounts: { total: number; enrolled: number; suspended: number; withPurchase: number; consented: number; newToday: number; new7d: number };
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
  totals: { requests: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number; debitedMicro: number };
  promo: { claimed: number; seats: number; remaining: number };
  books: { outOfBalance: number; lastPassAt: number | null; restatedDays: number };
  top: Array<{ email: string; tenantId: string; creditedMicro: number; spentMicro: number; requests: number; paid: boolean; suspended: boolean; enrolled: boolean }>;
}

export interface AdminTraffic {
  configured: boolean;
  error: string | null;
  totals: { views: number; sites: number };
  pages: Array<Record<string, string | number | null>>;
  sources: Array<Record<string, string | number | null>>;
  clicks: Array<Record<string, string | number | null>>;
}

export const readDashboard = () => request<AdminDashboard>('GET', '/admin/dashboard');
export const readTraffic = (days = 7) => request<AdminTraffic>('GET', `/admin/traffic?days=${days}`);
export const readWebhookFailures = () => request<{ data: unknown[] }>('GET', '/admin/webhook-failures');
export const readCreditRequests = () => request<{ data: unknown[] }>('GET', '/admin/credit-requests');

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
  'alert-test': { method: 'POST', path: '/admin/alert-test', label: 'Send a test alert' },
  enroll: { method: 'POST', path: '/admin/accounts/{tenant}/enroll', label: 'Enroll with the engine', needsTenant: true },
  suspend: { method: 'POST', path: '/admin/accounts/{tenant}/suspend', label: 'Suspend account', needsTenant: true },
  restore: { method: 'POST', path: '/admin/accounts/{tenant}/restore', label: 'Restore account', needsTenant: true },
} as const;

export type ActionName = keyof typeof ACTIONS;

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

export async function runAction(name: ActionName, tenant?: string): Promise<unknown> {
  const action = ACTIONS[name];
  const needsTenant = 'needsTenant' in action && action.needsTenant;
  if (needsTenant && !tenant) throw new Error(`${name} needs a tenant id`);
  // Tenant ids are the console's own opaque ids; anything else is a path-injection
  // attempt, so it is rejected here rather than encoded and forwarded.
  if (tenant && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new Error(`bad tenant id ${tenant}`);
  const path = needsTenant ? action.path.replace('{tenant}', tenant!) : action.path;
  return request<unknown>('POST', path);
}
