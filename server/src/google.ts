// Self-serve google oauth (installed-app loopback flow) + token brokering for comms.
// Owner feedback: "if google failed it's first an issue of the app" — atrium owns its
// connection. Hermes creds are a read-only fallback ("use hermes but not lean on hermes").
//
// Files:
//   ~/.config/atrium/google_client.json   — optional client-creds override (atrium-owned)
//   ~/.hermes/google_client_secret.json   — hermes client creds, READ-ONLY fallback
//   ~/.config/atrium/google_token.json    — atrium-owned refresh token (written here, 0600)
//   ~/.hermes/google_token.json           — hermes token, READ-ONLY fallback, never written
//
// Secrets never leave this module: not in returned HTML, not in errors, not in logs.

import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { readJson } from './util.js';

const ATRIUM_CLIENT_PATH = join(config.configDir, 'google_client.json');
const ATRIUM_TOKEN_PATH = join(config.configDir, 'google_token.json');
const HERMES_CLIENT_PATH = join(config.paths.hermesHome, 'google_client_secret.json');
const HERMES_TOKEN_PATH = config.paths.googleToken; // READ-ONLY — hermes owns this file

const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly';
const TIMEOUT_MS = 10_000;
const STATE_TTL_MS = 10 * 60_000;
const CONNECT_HINT = 'click connect google in the comms panel';

// ---------- file shapes ----------

interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

/** Atrium-owned token file (we write this). */
interface AtriumTokenFile {
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  token_uri?: string;
  scopes?: string[];
  obtained_at?: string;
}

/** Standard authorized_user JSON written by hermes. Read-only — hermes owns rotation. */
interface HermesTokenFile {
  token?: string;
  refresh_token?: string;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  expiry?: string;
}

type Source = 'atrium' | 'hermes';

// ---------- module state ----------

/** Cached access token (never persisted). */
let mem: { token: string; source: Source; expiresAt: number } | null = null;

/** Sources whose last refresh died with invalid_grant (revoked/expired refresh token). */
const invalidGrant = new Map<Source, string>();

/** Pending oauth state params → expiry epoch ms. Single-use, 10-min TTL. */
const pendingStates = new Map<string, number>();

function prunePendingStates(now = Date.now()): void {
  for (const [s, exp] of pendingStates) if (exp <= now) pendingStates.delete(s);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redirectUri(): string {
  return `http://localhost:${config.port}/api/google/callback`;
}

async function loadClientCreds(): Promise<ClientCreds | null> {
  for (const path of [ATRIUM_CLIENT_PATH, HERMES_CLIENT_PATH]) {
    const j = await readJson<any>(path);
    const c = j?.installed ?? j?.web ?? j;
    if (typeof c?.client_id === 'string' && typeof c?.client_secret === 'string') {
      return { clientId: c.client_id, clientSecret: c.client_secret };
    }
  }
  return null;
}

/** Atomic 0600 write of the atrium-owned token file. */
async function saveAtriumToken(tok: Required<Omit<AtriumTokenFile, 'scopes'>> & { scopes: string[] }): Promise<void> {
  await mkdir(config.configDir, { recursive: true });
  // unique tmp so concurrent callbacks don't race on a shared tmp path
  const tmp = `${ATRIUM_TOKEN_PATH}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(tok, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, ATRIUM_TOKEN_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // never leave a secret-bearing tmp behind
    throw err;
  }
}

// ---------- token brokering (used by the comms collector) ----------

export type AccessTokenResult = { token: string; source: Source } | { error: string; hint: string };

/** Drop the cached access token (call after a 401 from a google API). */
export function invalidateAccessToken(): void {
  mem = null;
}

async function refreshAccessToken(
  source: Source,
  tokenUri: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<AccessTokenResult> {
  try {
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const msg = body.error
        ? `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`
        : `HTTP ${res.status}`;
      if (body.error === 'invalid_grant') invalidGrant.set(source, msg);
      return { error: `${source} token refresh failed — ${msg}`, hint: CONNECT_HINT };
    }
    invalidGrant.delete(source);
    mem = {
      token: String(body.access_token),
      source,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return { token: mem.token, source };
  } catch (err) {
    return { error: `${source} token refresh failed — ${errMsg(err)}`, hint: CONNECT_HINT };
  }
}

/**
 * Get a usable access token. Preference: atrium-owned token file, then the hermes
 * file as a read-only fallback. In-memory cache with expiry; refresh via token_uri.
 */
export async function getAccessToken(): Promise<AccessTokenResult> {
  const now = Date.now();
  if (mem && mem.expiresAt - 60_000 > now) return { token: mem.token, source: mem.source };

  const failures: string[] = [];

  // 1) atrium's own token
  const atrium = await readJson<AtriumTokenFile>(ATRIUM_TOKEN_PATH);
  if (atrium) {
    const dead = invalidGrant.get('atrium');
    if (dead) {
      // known-revoked refresh token — don't re-POST it to google every comms cycle;
      // a new connect (googleCallback) clears this, mirroring googleStatus
      failures.push(`atrium token rejected (${dead})`);
    } else if (atrium.refresh_token && atrium.client_id && atrium.client_secret) {
      const r = await refreshAccessToken(
        'atrium',
        atrium.token_uri || TOKEN_URI,
        atrium.client_id,
        atrium.client_secret,
        atrium.refresh_token,
      );
      if ('token' in r) return r;
      failures.push(r.error);
    } else {
      failures.push('atrium token file is missing refresh_token/client fields');
    }
  }

  // 2) hermes fallback — read-only
  const hermes = await readJson<HermesTokenFile>(HERMES_TOKEN_PATH);
  if (hermes) {
    // ride hermes' own unexpired access token first — don't race its rotation
    if (hermes.token && hermes.expiry) {
      const exp = new Date(hermes.expiry).getTime();
      if (Number.isFinite(exp) && exp - 60_000 > now) {
        mem = { token: hermes.token, source: 'hermes', expiresAt: exp };
        return { token: mem.token, source: 'hermes' };
      }
    }
    const dead = invalidGrant.get('hermes');
    if (dead) {
      failures.push(`hermes token rejected (${dead})`);
    } else if (hermes.refresh_token && hermes.client_id && hermes.client_secret) {
      const r = await refreshAccessToken(
        'hermes',
        hermes.token_uri || TOKEN_URI,
        hermes.client_id,
        hermes.client_secret,
        hermes.refresh_token,
      );
      if ('token' in r) return r;
      failures.push(r.error);
    } else {
      failures.push('hermes token file is missing refresh_token/client fields');
    }
  }

  if (!atrium && !hermes) failures.push('no google token on disk (atrium or hermes)');
  return { error: failures.join('; '), hint: CONNECT_HINT };
}

// ---------- status (drives the comms panel connect button) ----------

export async function googleStatus(): Promise<{
  connected: boolean;
  source: Source | null;
  hint: string | null;
}> {
  const atrium = await readJson<AtriumTokenFile>(ATRIUM_TOKEN_PATH);
  const atriumUsable = !!(atrium?.refresh_token && atrium.client_id && atrium.client_secret);
  if (atriumUsable && !invalidGrant.has('atrium')) return { connected: true, source: 'atrium', hint: null };

  const hermes = await readJson<HermesTokenFile>(HERMES_TOKEN_PATH);
  const hermesUsable = !!(hermes?.refresh_token && hermes.client_id && hermes.client_secret);
  if (hermesUsable && !invalidGrant.has('hermes')) return { connected: true, source: 'hermes', hint: null };

  const reasons: string[] = [];
  const ag = invalidGrant.get('atrium');
  const hg = invalidGrant.get('hermes');
  if (ag) reasons.push(`atrium token rejected (${ag})`);
  else if (atrium && !atriumUsable) reasons.push('atrium token file incomplete');
  if (hg) reasons.push(`hermes token rejected (${hg})`);
  else if (hermes && !hermesUsable) reasons.push('hermes token file incomplete');
  if (!atrium && !hermes) reasons.push('no google account connected');
  const hint = `${reasons.length ? `${reasons.join('; ')} — ` : ''}${CONNECT_HINT}`;
  return { connected: false, source: null, hint };
}

// ---------- oauth flow ----------

export async function googleAuthUrl(): Promise<string> {
  const creds = await loadClientCreds();
  if (!creds) {
    throw new Error(
      `no google oauth client credentials — put an installed-app client json (with .installed.client_id/.client_secret) at ${ATRIUM_CLIENT_PATH}, or make ${HERMES_CLIENT_PATH} readable`,
    );
  }
  prunePendingStates();
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  const u = new URL(AUTH_URI);
  u.searchParams.set('client_id', creds.clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  return u.toString();
}

/** Completes the loopback oauth flow. Always resolves to a small HTML page — never throws. */
export async function googleCallback(params: URLSearchParams): Promise<string> {
  try {
    prunePendingStates();
    const state = params.get('state') ?? '';
    const exp = pendingStates.get(state);
    if (!state || exp === undefined || exp <= Date.now()) {
      return errorPage('this sign-in link is stale or was already used — click connect google again');
    }
    pendingStates.delete(state); // single-use

    const denied = params.get('error');
    if (denied) return errorPage(`google refused the sign-in (${denied}) — click connect google to retry`);
    const code = params.get('code');
    if (!code) return errorPage('google sent no authorization code — click connect google to retry');

    const creds = await loadClientCreds();
    if (!creds) return errorPage('google oauth client credentials are gone — click connect google to retry');

    let body: any;
    try {
      const res = await fetch(TOKEN_URI, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) {
        const msg = body.error
          ? `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`
          : `HTTP ${res.status}`;
        return errorPage(`token exchange failed — ${msg}`);
      }
    } catch (err) {
      return errorPage(`token exchange failed — ${errMsg(err)}`);
    }

    if (!body.refresh_token) {
      return errorPage(
        'google returned no refresh token — revoke atrium at myaccount.google.com/permissions, then click connect google again',
      );
    }

    const scopes = typeof body.scope === 'string' && body.scope ? body.scope.split(' ') : SCOPES.split(' ');
    await saveAtriumToken({
      refresh_token: String(body.refresh_token),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      token_uri: TOKEN_URI,
      scopes,
      obtained_at: new Date().toISOString(),
    });
    invalidGrant.delete('atrium');
    // seed the cache so the next comms run doesn't need a refresh round-trip
    mem = {
      token: String(body.access_token),
      source: 'atrium',
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return successPage();
  } catch (err) {
    return errorPage(`google connect failed — ${errMsg(err)}`);
  }
}

// ---------- html (dark, self-contained, no external assets, no secrets) ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, message: string, accent: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>atrium — google</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0a0e14;color:#e8edf4;font:15px/1.6 system-ui,-apple-system,sans-serif}
  main{max-width:30rem;padding:2rem;text-align:center}
  h1{font-size:1rem;font-weight:600;letter-spacing:.02em;color:${accent};margin:0 0 .5rem}
  p{color:#8b96a5;font-size:.85rem;margin:0}
</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>
`;
}

function successPage(): string {
  return page('google connected', 'you can close this tab — atrium picks it up on the next refresh.', '#6fd0a8');
}

function errorPage(message: string): string {
  return page('google connect failed', message, '#e8796f');
}
