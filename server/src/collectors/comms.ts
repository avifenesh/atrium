import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso, readJson } from '../util.js';
import type { Collector } from './registry.js';
import type { CalendarEvent, CommsState, EmailThread } from '../../../shared/types.js';

/** Standard authorized_user JSON written by hermes. Read-only — hermes owns rotation of this file. */
interface GoogleTokenFile {
  token?: string;
  refresh_token?: string;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  expiry?: string;
}

const TOKEN_CACHE_PATH = join(config.configDir, 'google_token_cache.json');
const TIMEOUT_MS = 10_000;

let mem: { token: string; expiresAt: number } | null = null;
let seeded = false;

type AuthResult = { token: string } | { status: 'disabled' | 'auth-error'; error: string };

async function getAccessToken(): Promise<AuthResult> {
  const now = Date.now();
  if (mem && mem.expiresAt - 60_000 > now) return { token: mem.token };

  const tok = await readJson<GoogleTokenFile>(config.paths.googleToken);
  if (!tok) {
    return {
      status: 'disabled',
      error: `google token file missing or unreadable: ${config.paths.googleToken} (run hermes google auth to enable)`,
    };
  }

  if (!seeded) {
    seeded = true;
    // Survive restarts without an extra refresh: prefer our own cache, else the
    // hermes file's current access token if it hasn't expired yet.
    const cached = await readJson<{ access_token?: string; expires_at?: number }>(TOKEN_CACHE_PATH);
    if (cached?.access_token && typeof cached.expires_at === 'number' && cached.expires_at - 60_000 > now) {
      mem = { token: cached.access_token, expiresAt: cached.expires_at };
      return { token: mem.token };
    }
    if (tok.token && tok.expiry) {
      const exp = new Date(tok.expiry).getTime();
      if (Number.isFinite(exp) && exp - 60_000 > now) {
        mem = { token: tok.token, expiresAt: exp };
        return { token: mem.token };
      }
    }
  }

  if (!tok.refresh_token || !tok.token_uri || !tok.client_id || !tok.client_secret) {
    return { status: 'auth-error', error: 'google token file lacks refresh_token/token_uri/client fields' };
  }

  try {
    const res = await fetch(tok.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: tok.client_id,
        client_secret: tok.client_secret,
        refresh_token: tok.refresh_token,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const oauthErr = body.error
        ? `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`
        : `HTTP ${res.status}`;
      return { status: 'auth-error', error: `google token refresh failed — ${oauthErr}` };
    }
    mem = { token: String(body.access_token), expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
    // Best-effort cache so a restart doesn't force a refresh. 0600 — file holds an access token.
    try {
      await mkdir(config.configDir, { recursive: true });
      await writeFile(TOKEN_CACHE_PATH, JSON.stringify({ access_token: mem.token, expires_at: mem.expiresAt }), {
        mode: 0o600,
      });
    } catch {
      // cache is optional
    }
    return { token: mem.token };
  } catch (err) {
    return { status: 'auth-error', error: `google token refresh failed — ${errMsg(err)}` };
  }
}

async function gFetch(url: string, token: string): Promise<any> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) mem = null; // token revoked mid-cycle — force refresh on next run
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
  return res.json();
}

/** "Display Name <a@b.c>" → "Display Name"; bare address stays as-is. */
function fromDisplay(raw: string): string {
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*</);
  if (m?.[1]?.trim()) return m[1].trim();
  return raw.replace(/[<>]/g, '').trim();
}

/** Gmail snippets arrive HTML-entity-escaped. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function fetchEmail(token: string): Promise<CommsState['email']> {
  const label = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX', token);
  const unreadCount = Number(label.threadsUnread) || 0;

  const list = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in%3Ainbox&maxResults=12', token);
  const ids: string[] = (Array.isArray(list.messages) ? list.messages : []).slice(0, 12).map((m: any) => String(m.id));

  const metas = await Promise.all(
    ids.map(async (id) => {
      try {
        return await gFetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          token,
        );
      } catch {
        return null; // one unreadable message must not sink the inbox view
      }
    }),
  );

  const byThread = new Map<string, EmailThread & { ts: number }>();
  for (const m of metas) {
    if (!m) continue;
    const headers: { name?: string; value?: string }[] = m.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? '';
    const ts = Number(m.internalDate) || 0;
    const threadId = String(m.threadId ?? m.id);
    const prev = byThread.get(threadId);
    if (prev && prev.ts >= ts) continue; // dedupe by thread, keep newest message
    byThread.set(threadId, {
      ts,
      id: threadId,
      from: fromDisplay(h('from')),
      subject: h('subject') || '(no subject)',
      date: iso(ts),
      snippet: decodeEntities(String(m.snippet ?? '')),
      unread: Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD'),
    });
  }

  const threads: EmailThread[] = [...byThread.values()]
    .sort((a, b) => b.ts - a.ts)
    .map(({ ts: _ts, ...t }) => t);

  return { status: 'ok', unreadCount, threads, error: null };
}

/** Local calendar date (system tz = Asia/Jerusalem) — used to split today vs upcoming. */
function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function fetchCalendar(token: string): Promise<CommsState['calendar']> {
  const now = new Date();
  const timeMin = encodeURIComponent(now.toISOString());
  const timeMax = encodeURIComponent(new Date(now.getTime() + 7 * 86_400_000).toISOString());
  const data = await gFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=40`,
    token,
  );

  const todayKey = localDateKey(now);
  const today: CalendarEvent[] = [];
  const upcoming: CalendarEvent[] = [];
  for (const item of Array.isArray(data.items) ? data.items : []) {
    const allDay = !!item.start?.date;
    const start = String(item.start?.dateTime ?? item.start?.date ?? '');
    if (!start) continue;
    const ev: CalendarEvent = {
      id: String(item.id ?? ''),
      title: String(item.summary ?? '(untitled)'),
      start,
      end: String(item.end?.dateTime ?? item.end?.date ?? start),
      allDay,
      location: item.location != null ? String(item.location) : null,
      calendar: 'primary',
    };
    // all-day starts are already local YYYY-MM-DD strings.
    // bucket by interval intersection with today: timeMin=now guarantees end >= now, so an
    // event is "today" iff it starts on or before today — multi-day/overnight events included
    const key = allDay ? start : localDateKey(new Date(start));
    (key <= todayKey ? today : upcoming).push(ev);
  }
  return { status: 'ok', today, upcoming, error: null };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const comms: Collector = {
  name: 'comms',
  intervalMs: config.poll.commsMs,
  async run() {
    let state: CommsState;
    try {
      const auth = await getAccessToken();
      if ('status' in auth) {
        state = {
          updatedAt: iso(),
          email: { status: auth.status, unreadCount: 0, threads: [], error: auth.error },
          calendar: { status: auth.status, today: [], upcoming: [], error: auth.error },
        };
      } else {
        // email and calendar fail independently
        const [email, calendar] = await Promise.all([
          fetchEmail(auth.token).catch(
            (err): CommsState['email'] => ({ status: 'error', unreadCount: 0, threads: [], error: errMsg(err) }),
          ),
          fetchCalendar(auth.token).catch(
            (err): CommsState['calendar'] => ({ status: 'error', today: [], upcoming: [], error: errMsg(err) }),
          ),
        ]);
        state = { updatedAt: iso(), email, calendar };
      }
    } catch (err) {
      const e = errMsg(err);
      state = {
        updatedAt: iso(),
        email: { status: 'error', unreadCount: 0, threads: [], error: e },
        calendar: { status: 'error', today: [], upcoming: [], error: e },
      };
    }
    store.setSection('comms', state);
  },
};

export default comms;
