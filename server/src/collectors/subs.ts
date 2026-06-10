import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso, mtime, readJson } from '../util.js';
import type { Collector } from './registry.js';
import type { Flag, SubService, SubsState } from '../../../shared/types.js';

const TIMEOUT_MS = 10_000;

// Flag state: only flag the claude usage endpoint when it regresses after having worked.
let usageEverWorked = false;
let usageRegressed = false;
let usageFlagRaisedAt: string | null = null;

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Walk the oauth usage response for rate-limit windows. Shape is undocumented and
 * has shifted before, so match any nested object carrying a numeric `utilization`.
 */
function extractUsageWindows(data: any): NonNullable<SubService['usage']> {
  const out: NonNullable<SubService['usage']> = [];
  const visit = (node: any, label: string, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 3) return;
    if (typeof node.utilization === 'number') {
      const u = node.utilization;
      const reset = node.resets_at ?? node.reset_at ?? null;
      out.push({
        label: label.replace(/[_.]/g, ' ').trim() || 'usage',
        // the endpoint has used both 0..1 and 0..100 scales
        usedPct: Math.round((u <= 1 ? u * 100 : u) * 10) / 10,
        resetAt:
          reset == null ? null : typeof reset === 'number' ? iso(reset > 1e12 ? reset : reset * 1000) : String(reset),
      });
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, label ? `${label} ${k}` : k, depth + 1);
  };
  visit(data, '', 0);
  return out;
}

/** Sum dailyModelTokens across all models for the last 7 local calendar days. */
async function last7dTokens(): Promise<string | null> {
  const stats = await readJson<any>(config.paths.claudeStatsCache);
  const days: any[] = Array.isArray(stats?.dailyModelTokens) ? stats.dailyModelTokens : [];
  if (days.length === 0) return null;
  const cutoff = new Date(Date.now() - 6 * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const cutoffKey = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
  let total = 0;
  for (const d of days) {
    if (typeof d?.date !== 'string' || d.date < cutoffKey) continue;
    for (const v of Object.values(d.tokensByModel ?? {})) total += Number(v) || 0;
  }
  return total > 0 ? `${fmtTokens(total)} tokens last 7d` : null;
}

async function claudeService(): Promise<SubService> {
  const src = config.paths.claudeCredentials;
  const creds = await readJson<any>(src);
  const oauth = creds?.claudeAiOauth;
  if (!oauth) {
    return {
      id: 'claude',
      name: 'Claude',
      status: 'not-connected',
      plan: null,
      detail: `no claudeAiOauth in ${src}`,
      usage: null,
      source: src,
    };
  }

  let usage: SubService['usage'] = null;
  let usageFailed = false;
  // NEVER refresh this token — the claude CLI owns rotation.
  if (typeof oauth.accessToken === 'string' && typeof oauth.expiresAt === 'number' && oauth.expiresAt > Date.now()) {
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const windows = extractUsageWindows(await res.json());
      usage = windows.length > 0 ? windows : null;
      usageEverWorked = true;
      usageRegressed = false;
    } catch {
      usageFailed = true;
    }
  } else {
    usageFailed = true; // expired/absent access token also means usage is unavailable
  }
  if (usageFailed) usageRegressed = usageEverWorked;

  const parts: string[] = [];
  if (oauth.rateLimitTier != null) parts.push(String(oauth.rateLimitTier));
  if (usage === null) parts.push('(usage unavailable)');
  const tokens7d = await last7dTokens();
  if (tokens7d) parts.push(tokens7d);

  return {
    id: 'claude',
    name: 'Claude',
    status: 'active',
    plan: oauth.subscriptionType != null ? String(oauth.subscriptionType) : null,
    detail: parts.length > 0 ? parts.join('; ') : null,
    usage,
    source: src,
  };
}

async function codexService(): Promise<SubService | null> {
  const src = join(config.paths.codexHome, 'auth.json');
  const auth = await readJson<any>(src);
  if (!auth) return null;
  return {
    id: 'codex',
    name: 'Codex',
    status: 'off', // user disabled codex
    plan: typeof auth.auth_mode === 'string' ? auth.auth_mode : null,
    detail: 'disabled by user; no usage API for ChatGPT plans',
    usage: null,
    source: src,
  };
}

async function grokService(): Promise<SubService | null> {
  const src = config.paths.grokAuth;
  const auth = await readJson<any>(src);
  if (!auth) return null;
  return {
    id: 'grok',
    name: 'Grok',
    status: 'active',
    plan: 'x.ai oauth',
    detail: null,
    usage: null,
    source: src,
  };
}

async function hermesPoolServices(): Promise<SubService[]> {
  const src = config.paths.hermesAuth;
  const auth = await readJson<any>(src);
  const pool = auth?.credential_pool ?? {};
  const active = typeof auth?.active_provider === 'string' ? auth.active_provider : null;
  const wanted: [string, string][] = [
    ['zai', 'Z.ai'],
    ['copilot', 'GitHub Copilot'],
  ];
  return wanted.map(([id, name]) => {
    const entry = pool[id];
    const has = Array.isArray(entry) ? entry.length > 0 : entry != null;
    return {
      id,
      name,
      status: has ? ('active' as const) : ('not-connected' as const),
      plan: null,
      detail: auth
        ? `hermes credential pool${has ? '' : ' (no entry)'}; active provider: ${active ?? 'none'}${active === id ? ' (this)' : ''}`
        : `hermes auth file missing: ${src}`,
      usage: null,
      source: src,
    };
  });
}

async function cursorService(): Promise<SubService | null> {
  const src = config.paths.cursorAgent;
  if (!(await mtime(src))) return null;
  return {
    id: 'cursor',
    name: 'Cursor',
    status: 'unknown',
    plan: null,
    detail: 'cursor-agent installed; no usage API',
    usage: null,
    source: src,
  };
}

function spotifyService(): SubService {
  return {
    id: 'spotify',
    name: 'Spotify',
    status: 'not-connected',
    plan: null,
    detail: 'connect via: hermes auth login spotify (token lands in ~/.hermes/auth.json)',
    usage: null,
    source: config.paths.hermesAuth,
  };
}

/** User-editable extras: array of {id,name,plan,detail}; overlays matching ids, appends the rest. */
async function mergeManual(services: SubService[]): Promise<void> {
  const src = join(config.configDir, 'subscriptions.json');
  const manual = await readJson<any[]>(src);
  if (!Array.isArray(manual)) return;
  for (const m of manual) {
    if (!m || typeof m.id !== 'string') continue;
    const existing = services.find((s) => s.id === m.id);
    if (existing) {
      if (typeof m.name === 'string') existing.name = m.name;
      if (m.plan != null) existing.plan = String(m.plan);
      if (m.detail != null) existing.detail = String(m.detail);
    } else {
      services.push({
        id: m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
        status: 'active',
        plan: m.plan != null ? String(m.plan) : null,
        detail: m.detail != null ? String(m.detail) : null,
        usage: null,
        source: src,
      });
    }
  }
}

const subs: Collector = {
  name: 'subs',
  intervalMs: config.poll.subsMs,
  async run() {
    let state: SubsState;
    let flags: Flag[] = [];
    try {
      const [claude, codex, grok, hermesPool, cursor] = await Promise.all([
        claudeService(),
        codexService(),
        grokService(),
        hermesPoolServices(),
        cursorService(),
      ]);
      const services: SubService[] = [claude];
      if (codex) services.push(codex);
      if (grok) services.push(grok);
      services.push(...hermesPool);
      if (cursor) services.push(cursor);
      services.push(spotifyService());
      await mergeManual(services);
      state = { updatedAt: iso(), services, error: null };

      if (usageRegressed) {
        usageFlagRaisedAt ??= iso();
        flags = [
          {
            id: 'subs:claude-usage',
            severity: 'info',
            title: 'claude usage fetch stopped working',
            detail: 'oauth usage endpoint failed after previously working; usage bars are stale until the claude CLI rotates the token',
            source: 'subs',
            raisedAt: usageFlagRaisedAt,
          },
        ];
      } else {
        usageFlagRaisedAt = null;
      }
    } catch (err) {
      state = { updatedAt: iso(), services: [], error: err instanceof Error ? err.message : String(err) };
    }
    store.setSection('subs', state);
    store.setFlags('subs', flags);
  },
};

export default subs;
