import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { getCursorUsage } from '../cursor-usage.js';
import { getSpotifyAccessToken } from '../spotify.js';
import { getXaiUsage } from '../xai-usage.js';
import { store } from '../state.js';
import { ago, iso, mtime, readJson, readText, shTry, tailLines } from '../util.js';
import type { Collector } from './registry.js';
import type { Flag, SubService, SubsState } from '../../../shared/types.js';

const TIMEOUT_MS = 5_000;
const ZAI_TIMEOUT_MS = 3_000;

// Last-good card per service id: a transient fetch/read failure must not blank or
// flicker a card that rendered fine last cycle. Stored/returned as clones so
// mergeManual overlays never mutate the cache.
const lastGood = new Map<string, SubService>();

function remember(id: string, s: SubService): SubService {
  lastGood.set(id, structuredClone(s));
  return s;
}

function recall(id: string): SubService | null {
  const s = lastGood.get(id);
  return s ? structuredClone(s) : null;
}

/** Failure isolation per service: one service throwing must not blank the panel. */
async function safe(id: string, fn: () => Promise<SubService | null>): Promise<SubService | null> {
  try {
    const s = await fn();
    return s ? remember(id, s) : recall(id);
  } catch {
    return recall(id);
  }
}

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

// ---------- claude (live oauth usage API + local stats cache) ----------

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
  if (usageFailed) {
    usageRegressed = usageEverWorked;
    usage = recall('claude')?.usage ?? null; // last-good bars beat a blank card
  }

  const parts: string[] = [];
  if (oauth.rateLimitTier != null) parts.push(String(oauth.rateLimitTier));
  if (usageFailed && usage !== null) parts.push('(usage cached)');
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
    source: usage !== null ? `${src} + api.anthropic.com oauth usage` : src,
  };
}

// ---------- codex (local stats via node:sqlite; no usage API for chatgpt plans) ----------

// DatabaseSync blocks the event loop, and the SUM/COUNT aggregates below scan the
// whole threads B-tree (rows carry content, ~15KB each; 65MB today and growing).
// Don't pay that on every 300s poll — cache the result and recompute infrequently.
const CODEX_STATS_TTL_MS = 30 * 60_000;
let codexStatsCache: { at: number; value: { parts: string[]; src: string } | null } | null = null;

function codexSqliteStatsCached(): { parts: string[]; src: string } | null {
  if (codexStatsCache && Date.now() - codexStatsCache.at < CODEX_STATS_TTL_MS) {
    return codexStatsCache.value;
  }
  const value = codexSqliteStats();
  codexStatsCache = { at: Date.now(), value };
  return value;
}

/**
 * Schema discovered 2026-06-10 in ~/.codex/state_5.sqlite:
 *   threads(id TEXT, tokens_used INTEGER, updated_at INTEGER seconds, updated_at_ms INTEGER, ...)
 * Aggregates only — never read message content.
 */
function codexSqliteStats(): { parts: string[]; src: string } | null {
  const path = join(config.paths.codexHome, 'state_5.sqlite');
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const all = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tokens_used), 0) AS tok, MAX(updated_at_ms) AS last FROM threads')
      .get() as any;
    const n = Number(all?.n) || 0;
    if (n === 0) return null;
    const week = db
      .prepare('SELECT COALESCE(SUM(tokens_used), 0) AS tok FROM threads WHERE updated_at_ms >= ?')
      .get(Date.now() - 7 * 86_400_000) as any;
    const parts: string[] = [`${n} local sessions`];
    const tok = Number(all?.tok) || 0;
    if (tok > 0) parts.push(`${fmtTokens(tok)} tokens total`);
    const wtok = Number(week?.tok) || 0;
    if (wtok > 0) parts.push(`${fmtTokens(wtok)} last 7d`);
    const last = Number(all?.last) || 0;
    if (last > 0) parts.push(`last activity ${ago(last)}`);
    return { parts, src: path };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/** Fallback when sqlite is unreadable: date of the newest session_index.jsonl entry. */
async function codexLastSessionDate(): Promise<string | null> {
  const lines = await tailLines(config.paths.codexSessionIndex, 1);
  const line = lines[lines.length - 1];
  if (!line) return null;
  try {
    const entry = JSON.parse(line);
    return typeof entry?.updated_at === 'string' ? entry.updated_at.slice(0, 10) : null;
  } catch {
    return null;
  }
}

async function codexService(): Promise<SubService | null> {
  const src = join(config.paths.codexHome, 'auth.json');
  const auth = await readJson<any>(src);
  if (!auth) return null;
  const stats = codexSqliteStatsCached();
  let detail: string;
  let source = src;
  if (stats) {
    detail = `disabled by user; ${stats.parts.join(', ')} — no usage API for chatgpt plans`;
    source = `${src} + ${stats.src}`;
  } else {
    const lastDate = await codexLastSessionDate();
    detail = lastDate
      ? `disabled by user; last session ${lastDate} — no usage API for chatgpt plans`
      : 'disabled by user; no usage API for ChatGPT plans';
    if (lastDate) source = `${src} + ${config.paths.codexSessionIndex}`;
  }
  return {
    id: 'codex',
    name: 'Codex',
    status: 'off', // user disabled codex
    plan: typeof auth.auth_mode === 'string' ? auth.auth_mode : null,
    detail,
    usage: null,
    source,
  };
}

// ---------- grok (local session stats; x.ai has no usage API for oauth accounts) ----------

/**
 * Schema discovered 2026-06-10 in ~/.grok/sessions/session_search.sqlite:
 *   session_docs(session_id TEXT, cwd TEXT, updated_at INTEGER seconds, title TEXT, ...)
 */
function grokSqliteStats(): { n: number; lastMs: number } | null {
  const path = join(config.paths.grokAuth, '..', 'sessions', 'session_search.sqlite');
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const r = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM session_docs').get() as any;
    const n = Number(r?.n) || 0;
    const last = Number(r?.last) || 0;
    return n > 0 ? { n, lastMs: last * 1000 } : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

async function grokService(): Promise<SubService | null> {
  const src = config.paths.grokAuth;
  const auth = await readJson<any>(src);
  if (!auth) return null;

  // local session count is always shown; usage/credits come from xai-usage:
  //   PATH A (internal token tier, zero-config) or PATH B (pasted management key).
  const stats = grokSqliteStats();
  const sessionPart = stats ? `${stats.n} local sessions; last activity ${ago(stats.lastMs)}` : null;

  const xai = await getXaiUsage();

  if ('error' in xai) {
    // only a hint (no key pasted, RPC unavailable) — surface the hint, NOT an error dump,
    // and keep the local session-count detail the block already computes.
    const parts: string[] = [];
    if (sessionPart) parts.push(sessionPart);
    parts.push(xai.hint);
    return {
      id: 'grok',
      name: 'Grok',
      status: 'active',
      plan: 'x.ai oauth',
      detail: parts.join('; '),
      usage: null,
      source: stats ? `${src} + sessions/session_search.sqlite` : src,
    };
  }

  // usable usage from PATH A or PATH B
  const parts: string[] = [];
  if (sessionPart) parts.push(sessionPart);
  parts.push(xai.detail);

  // a usage bar only where a real number exists: spend-vs-limit when both known.
  let usage: SubService['usage'] = null;
  if (typeof xai.spend === 'number' && typeof xai.limit === 'number' && xai.limit > 0) {
    usage = [
      {
        label: 'spend',
        usedPct: Math.min(100, Math.max(0, Math.round((xai.spend / xai.limit) * 1000) / 10)),
        resetAt: null,
      },
    ];
  }

  const plan = xai.tier ? `x.ai ${xai.tier}` : xai.source === 'mgmt' ? 'x.ai billing' : 'x.ai oauth';
  const sourceTag =
    xai.source === 'mgmt'
      ? 'management-api.x.ai billing (key via in-app paste)'
      : 'x.ai internal token';

  return {
    id: 'grok',
    name: 'Grok',
    status: 'active',
    plan,
    detail: parts.join('; '),
    usage,
    source: `${stats ? `${src} + sessions/session_search.sqlite + ` : `${src} + `}${sourceTag}`,
  };
}

// ---------- zai (GLM coding plan quota API) ----------

/** Read one var from ~/.hermes/.env (the pool entry stores only a fingerprint). */
async function hermesEnvVar(name: string): Promise<string | null> {
  const text = await readText(join(config.paths.hermesHome, '.env'));
  if (!text) return null;
  const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return v || null;
}

/**
 * Documented coding-plan monitor endpoint (used by the opencode-glm-quota plugin and
 * the zai-usage-tracker extension): GET https://api.z.ai/api/monitor/usage/quota/limit
 * with `Authorization: <key>` (no Bearer prefix). Verified live 2026-06-10; response:
 * { success, data: { level: 'max', limits: [{ type: 'TOKENS_LIMIT'|'TIME_LIMIT',
 *   unit: 3=hour 5=day 6=week, number, percentage 0..100, nextResetTime ms,
 *   usage/currentValue (TIME_LIMIT tool-call cap/used) }] } }
 */
async function zaiQuota(
  token: string,
): Promise<{ plan: string | null; usage: SubService['usage']; tools: string | null } | null> {
  const res = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
    headers: { authorization: token, 'accept-language': 'en-US,en', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(ZAI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: any = await res.json();
  if (body?.success !== true || !Array.isArray(body?.data?.limits)) return null;
  const UNIT: Record<number, string> = { 3: 'h', 5: 'd', 6: 'w' };
  const usage: NonNullable<SubService['usage']> = [];
  let tools: string | null = null;
  for (const l of body.data.limits) {
    if (!l || typeof l !== 'object') continue;
    const span = typeof l.unit === 'number' && UNIT[l.unit] ? `${l.number ?? ''}${UNIT[l.unit]}` : 'window';
    if (l.type === 'TIME_LIMIT' && typeof l.currentValue === 'number' && typeof l.usage === 'number') {
      tools = `tools ${l.currentValue}/${l.usage} per ${span}`;
    } else if (l.type === 'TOKENS_LIMIT' && typeof l.percentage === 'number') {
      usage.push({
        label: `tokens ${span}`,
        usedPct: Math.min(100, Math.max(0, Math.round(l.percentage * 10) / 10)),
        resetAt: typeof l.nextResetTime === 'number' ? iso(l.nextResetTime) : null,
      });
    }
  }
  return {
    plan: typeof body.data.level === 'string' ? body.data.level : null,
    usage: usage.length > 0 ? usage : null,
    tools,
  };
}

async function zaiService(): Promise<SubService> {
  const src = config.paths.hermesAuth;
  const auth = await readJson<any>(src);
  const entry = Array.isArray(auth?.credential_pool?.zai) ? auth.credential_pool.zai[0] : null;
  if (!entry) {
    return {
      id: 'zai',
      name: 'Z.ai',
      status: 'not-connected',
      plan: null,
      detail: auth ? 'no zai entry in hermes credential pool' : `hermes auth file missing: ${src}`,
      usage: null,
      source: src,
    };
  }

  let quota: Awaited<ReturnType<typeof zaiQuota>> = null;
  const token = await hermesEnvVar('GLM_API_KEY');
  if (token) {
    // cold TLS handshake to api.z.ai can exceed the 3s budget; one retry rides the warm pool
    for (let attempt = 0; attempt < 2 && !quota; attempt++) {
      try {
        quota = await zaiQuota(token);
      } catch {
        quota = null;
      }
    }
  }

  if (quota) {
    const parts = ['GLM coding plan'];
    if (quota.tools) parts.push(quota.tools);
    return {
      id: 'zai',
      name: 'Z.ai',
      status: 'active',
      plan: quota.plan,
      detail: parts.join('; '),
      usage: quota.usage,
      source: 'api.z.ai quota API (key from ~/.hermes/.env)',
    };
  }

  const cached = recall('zai');
  if (cached?.usage) {
    // strip any prior staleness suffix so repeated failures don't stack it
    const base = (cached.detail ?? 'GLM coding plan').replace(/ \(quota fetch failed; last known shown\)$/, '');
    cached.detail = `${base} (quota fetch failed; last known shown)`;
    return cached;
  }
  return {
    id: 'zai',
    name: 'Z.ai',
    status: 'active',
    plan: null,
    detail: 'coding plan active — quota API unreachable right now',
    usage: null,
    source: src,
  };
}

// ---------- copilot (quota via gh CLI — token stays in the keyring) ----------

async function copilotService(): Promise<SubService> {
  const src = config.paths.hermesAuth;
  const auth = await readJson<any>(src);
  const entry = Array.isArray(auth?.credential_pool?.copilot) ? auth.credential_pool.copilot[0] : null;

  // /copilot_internal/user answers to the gh CLI's gho_ token (verified 2026-06-10);
  // the documented /users/<login>/settings/billing endpoints 404 without the `user` scope.
  const out = await shTry('gh', ['api', '/copilot_internal/user'], { timeoutMs: TIMEOUT_MS });
  if (out) {
    try {
      const d: any = JSON.parse(out);
      const snaps: Record<string, any> = d?.quota_snapshots ?? {};
      const resetAt =
        typeof d?.quota_reset_date_utc === 'string'
          ? d.quota_reset_date_utc
          : typeof d?.quota_reset_date === 'string'
            ? d.quota_reset_date
            : null;
      const usage: NonNullable<SubService['usage']> = [];
      for (const [k, s] of Object.entries(snaps)) {
        if (!s || s.unlimited === true || typeof s.percent_remaining !== 'number') continue;
        usage.push({
          label: k.replace(/_/g, ' '),
          usedPct: Math.min(100, Math.max(0, Math.round((100 - s.percent_remaining) * 10) / 10)),
          resetAt,
        });
      }
      const parts: string[] = [];
      if (typeof d?.access_type_sku === 'string') parts.push(d.access_type_sku);
      const prem = snaps['premium_interactions'];
      if (prem && typeof prem.entitlement === 'number') parts.push(`${prem.entitlement} premium requests/period`);
      if (typeof d?.quota_reset_date === 'string') parts.push(`resets ${d.quota_reset_date}`);
      return {
        id: 'copilot',
        name: 'GitHub Copilot',
        status: 'active',
        plan: typeof d?.copilot_plan === 'string' ? d.copilot_plan : null,
        detail: parts.length > 0 ? parts.join('; ') : null,
        usage: usage.length > 0 ? usage : null,
        source: 'gh api /copilot_internal/user',
      };
    } catch {
      /* unparseable — fall through to pool presence */
    }
  }

  const cached = recall('copilot');
  if (cached?.usage) return cached;
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    status: entry ? 'active' : 'not-connected',
    plan: null,
    detail: entry
      ? 'hermes credential pool (gh token); usage not visible to this token'
      : auth
        ? 'no copilot entry in hermes credential pool'
        : `hermes auth file missing: ${src}`,
    usage: null,
    source: src,
  };
}

// ---------- cursor (live current-period usage via cursor-agent's own bearer) ----------

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function cursorService(): Promise<SubService | null> {
  const agentDir = config.paths.cursorAgent;
  const cliConfigPath = join(homedir(), '.cursor', 'cli-config.json');
  const cliConfig = await readJson<any>(cliConfigPath);
  const installed = (await mtime(agentDir)) != null;
  if (!cliConfig && !installed) return null;

  const authInfo = cliConfig?.authInfo;
  const usage = await getCursorUsage();

  if ('error' in usage) {
    // never blank a card that worked: safe() recalls last-good. With no cached card,
    // fall back to a quiet local-config summary carrying the calm hint (not an error dump).
    if (recall('cursor')) return recall('cursor');
    const parts: string[] = [];
    if (typeof authInfo?.email === 'string') parts.push(`logged in as ${authInfo.email}`);
    parts.push(usage.hint);
    return {
      id: 'cursor',
      name: 'Cursor',
      status: authInfo ? 'active' : 'unknown',
      plan: null,
      detail: parts.join('; '),
      usage: null,
      source: cliConfig ? cliConfigPath : agentDir,
    };
  }

  const detail =
    usage.limit > 0
      ? `${usd(usage.totalSpend)} of ${usd(usage.limit)} this cycle`
      : `${usage.percentUsed}% of included usage this cycle`;

  return {
    id: 'cursor',
    name: 'Cursor',
    status: 'active',
    plan: usage.plan,
    detail,
    usage: [{ label: 'spend', usedPct: usage.percentUsed, resetAt: usage.periodEnd }],
    source: `${cliConfig ? cliConfigPath : agentDir} + cursor dashboard usage API`,
  };
}

// ---------- spotify (self-serve PKCE connect; live account + now-playing) ----------

async function spotifyService(): Promise<SubService> {
  const tokenSrc = join(config.configDir, 'spotify_token.json');
  const tok = await getSpotifyAccessToken();
  if ('error' in tok) {
    // transient refresh trouble (network/5xx) must not flip a live card to not-connected
    if (tok.error.includes('refresh failed') && !tok.error.includes('invalid_grant')) {
      throw new Error(tok.error); // safe() recalls the last-good card
    }
    const revoked = tok.error.includes('rejected') || tok.error.includes('invalid_grant');
    return {
      id: 'spotify',
      name: 'Spotify',
      status: 'not-connected',
      plan: null,
      // short on purpose — the subs panel card carries the full two-step setup UI
      detail: revoked
        ? 'spotify access was revoked — redo setup: paste the app client id, then connect spotify'
        : 'two-step setup: paste the spotify app client id, then connect spotify',
      usage: null,
      source: tokenSrc,
    };
  }

  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { authorization: `Bearer ${tok.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`); // safe() recalls the last-good card
  const me: any = await res.json();
  const product = typeof me?.product === 'string' ? me.product : null; // 'premium' | 'free' | ...
  const name = typeof me?.display_name === 'string' && me.display_name ? me.display_name : null;
  let detail = [name, product].filter(Boolean).join(' — ') || 'connected';

  // now playing — best effort; a sleeping player (204) or a flaky fetch never breaks the card
  try {
    const p = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { authorization: `Bearer ${tok.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (p.status === 200) {
      const player: any = await p.json();
      const track = player?.item?.name;
      if (player?.is_playing === true && typeof track === 'string') {
        const artists = (Array.isArray(player?.item?.artists) ? player.item.artists : [])
          .map((a: any) => (typeof a?.name === 'string' ? a.name : null))
          .filter(Boolean)
          .join(', ');
        detail += `; playing: ${track}${artists ? ` — ${artists}` : ''}`;
      }
    }
  } catch {
    /* player endpoint is optional */
  }

  return {
    id: 'spotify',
    name: 'Spotify',
    status: 'active',
    plan: product,
    detail,
    usage: null,
    source: 'api.spotify.com /v1/me (token via in-app connect)',
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
      const [claude, codex, grok, zai, copilot, cursor, spotify] = await Promise.all([
        safe('claude', claudeService),
        safe('codex', codexService),
        safe('grok', grokService),
        safe('zai', zaiService),
        safe('copilot', copilotService),
        safe('cursor', cursorService),
        safe('spotify', spotifyService),
      ]);
      const services: SubService[] = [];
      for (const s of [claude, codex, grok, zai, copilot, cursor, spotify]) if (s) services.push(s);
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
