// Self-serve spotify connect (authorization code + PKCE — no client secret involved).
// One-time setup: the owner creates an app at developer.spotify.com/dashboard with the
// redirect URI http://127.0.0.1:5599/api/spotify/callback and pastes its Client ID into
// the subs panel. After that atrium owns the whole flow: consent, exchange, refresh.
//
// Files:
//   ~/.config/atrium/spotify_client.json — { client_id } (set via POST /api/spotify/client)
//   ~/.config/atrium/spotify_token.json  — refresh token, written here only, 0600 atomic
//
// Secrets never leave this module: not in returned HTML, not in errors, not in logs.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { readJson } from './util.js';

const CLIENT_PATH = join(config.configDir, 'spotify_client.json');
const TOKEN_PATH = join(config.configDir, 'spotify_token.json');

const AUTH_URI = 'https://accounts.spotify.com/authorize';
const TOKEN_URI = 'https://accounts.spotify.com/api/token';
const SCOPES = 'user-read-private user-read-email user-read-playback-state';
const TIMEOUT_MS = 10_000;
const STATE_TTL_MS = 10 * 60_000;
const CLIENT_ID_RE = /^[a-f0-9]{32}$/i;
const CONNECT_HINT = 'subs panel: paste the spotify app client id, then click connect spotify';

// ---------- file shapes ----------

interface ClientFile {
  client_id?: string;
}

/** Atrium-owned token file (we write this; nothing else does). */
interface TokenFile {
  refresh_token?: string;
  client_id?: string;
  obtained_at?: string;
  scopes?: string[];
}

// ---------- module state ----------

/** Cached access token (never persisted). */
let mem: { token: string; expiresAt: number } | null = null;

/** Set when the last refresh died with invalid_grant (revoked/expired refresh token). */
let invalidGrant: string | null = null;

/** Pending oauth state → its PKCE verifier + expiry epoch ms. Single-use, 10-min TTL. */
const pendingStates = new Map<string, { verifier: string; exp: number }>();

function prunePendingStates(now = Date.now()): void {
  for (const [s, p] of pendingStates) if (p.exp <= now) pendingStates.delete(s);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Spotify matches the redirect byte-for-byte against the app registration, and its app
 *  settings reject `localhost` — this literal loopback-IP form is what the subs panel
 *  tells the user to register. Keep the two in lockstep. */
function redirectUri(): string {
  return `http://127.0.0.1:${config.port}/api/spotify/callback`;
}

async function loadClientId(): Promise<string | null> {
  const j = await readJson<ClientFile>(CLIENT_PATH);
  const id = typeof j?.client_id === 'string' ? j.client_id.trim() : '';
  return CLIENT_ID_RE.test(id) ? id : null;
}

/** Atomic 0600 write of a small json file under ~/.config/atrium. */
async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(config.configDir, { recursive: true });
  // unique tmp so concurrent writes don't race on a shared tmp path
  const tmp = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // never leave a secret-bearing tmp behind
    throw err;
  }
}

// ---------- setup (one-time client id paste from the subs panel) ----------

export async function spotifySetClient(clientId: unknown): Promise<void> {
  const id = typeof clientId === 'string' ? clientId.trim() : '';
  if (!CLIENT_ID_RE.test(id)) {
    throw new Error(
      'client id must be the 32-char hex Client ID from your app at developer.spotify.com/dashboard',
    );
  }
  await saveJson(CLIENT_PATH, { client_id: id });
}

// ---------- token brokering (used by the subs collector) ----------

export type SpotifyAccessTokenResult = { token: string } | { error: string; hint: string };

export async function getSpotifyAccessToken(): Promise<SpotifyAccessTokenResult> {
  const now = Date.now();
  if (mem && mem.expiresAt - 60_000 > now) return { token: mem.token };

  const tok = await readJson<TokenFile>(TOKEN_PATH);
  if (!tok) return { error: 'spotify not connected — no token on disk', hint: CONNECT_HINT };
  if (invalidGrant) {
    // known-revoked refresh token — don't re-POST it to spotify every subs cycle;
    // a new connect (spotifyCallback) clears this
    return { error: `spotify token rejected (${invalidGrant})`, hint: CONNECT_HINT };
  }
  if (!tok.refresh_token || !tok.client_id) {
    return { error: 'spotify token file is missing refresh_token/client_id', hint: CONNECT_HINT };
  }

  try {
    const res = await fetch(TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: tok.client_id,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const msg = body.error
        ? `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`
        : `HTTP ${res.status}`;
      if (body.error === 'invalid_grant') invalidGrant = msg;
      return { error: `spotify token refresh failed — ${msg}`, hint: CONNECT_HINT };
    }
    // PKCE refresh rotates the refresh token — persist the new one or the saved one dies
    if (typeof body.refresh_token === 'string' && body.refresh_token !== tok.refresh_token) {
      await saveJson(TOKEN_PATH, {
        refresh_token: body.refresh_token,
        client_id: tok.client_id,
        obtained_at: new Date().toISOString(),
        scopes: tok.scopes ?? SCOPES.split(' '),
      });
    }
    mem = {
      token: String(body.access_token),
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return { token: mem.token };
  } catch (err) {
    return { error: `spotify token refresh failed — ${errMsg(err)}`, hint: CONNECT_HINT };
  }
}

// ---------- oauth flow (PKCE, loopback redirect) ----------

export async function spotifyAuthUrl(): Promise<string> {
  const clientId = await loadClientId();
  if (!clientId) {
    throw new Error(
      `no spotify client id — create an app at developer.spotify.com/dashboard with redirect URI ${redirectUri()}, then paste its Client ID into the subs panel (it lands in ${CLIENT_PATH})`,
    );
  }
  prunePendingStates();
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, { verifier, exp: Date.now() + STATE_TTL_MS });
  const u = new URL(AUTH_URI);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('state', state);
  return u.toString();
}

/** Completes the loopback PKCE flow. Always resolves to a small HTML page — never throws. */
export async function spotifyCallback(params: URLSearchParams): Promise<string> {
  try {
    prunePendingStates();
    const state = params.get('state') ?? '';
    const pending = pendingStates.get(state);
    if (!state || pending === undefined || pending.exp <= Date.now()) {
      return errorPage('this sign-in link is stale or was already used — click connect spotify again');
    }
    pendingStates.delete(state); // single-use

    const denied = params.get('error');
    if (denied) return errorPage(`spotify refused the sign-in (${denied}) — click connect spotify to retry`);
    const code = params.get('code');
    if (!code) return errorPage('spotify sent no authorization code — click connect spotify to retry');

    const clientId = await loadClientId();
    if (!clientId) {
      return errorPage('the saved spotify client id is gone — paste it again, then click connect spotify');
    }

    let body: any;
    try {
      const res = await fetch(TOKEN_URI, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
          client_id: clientId,
          code_verifier: pending.verifier,
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
      return errorPage('spotify returned no refresh token — click connect spotify to retry');
    }

    const scopes = typeof body.scope === 'string' && body.scope ? body.scope.split(' ') : SCOPES.split(' ');
    await saveJson(TOKEN_PATH, {
      refresh_token: String(body.refresh_token),
      client_id: clientId,
      obtained_at: new Date().toISOString(),
      scopes,
    });
    invalidGrant = null;
    // seed the cache so the next subs run doesn't need a refresh round-trip
    mem = {
      token: String(body.access_token),
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return successPage();
  } catch (err) {
    return errorPage(`spotify connect failed — ${errMsg(err)}`);
  }
}

// ---------- html (dark, self-contained, no external assets, no secrets) ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, message: string, accent: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>atrium — spotify</title>
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
  return page('spotify connected', 'you can close this tab — atrium picks it up on the next refresh.', '#6fd0a8');
}

function errorPage(message: string): string {
  return page('spotify connect failed', message, '#e8796f');
}
