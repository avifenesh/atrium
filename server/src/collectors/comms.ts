import { config } from '../config.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import { getAccessToken, googleStatus, invalidateAccessToken } from '../google.js';
import type { Collector } from './registry.js';
import type { CalendarEvent, CommsState, EmailThread } from '../../../shared/types.js';

const TIMEOUT_MS = 10_000;

async function gFetch(url: string, token: string): Promise<any> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) invalidateAccessToken(); // token revoked mid-cycle — force refresh on next run
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
      // after the auth attempt, so invalid_grant state is fresh
      const google = await googleStatus();
      if ('error' in auth) {
        state = {
          updatedAt: iso(),
          google,
          email: { status: 'auth-error', unreadCount: 0, threads: [], error: auth.hint },
          calendar: { status: 'auth-error', today: [], upcoming: [], error: auth.hint },
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
        state = { updatedAt: iso(), google, email, calendar };
      }
    } catch (err) {
      const e = errMsg(err);
      state = {
        updatedAt: iso(),
        google: { connected: false, source: null, hint: e },
        email: { status: 'error', unreadCount: 0, threads: [], error: e },
        calendar: { status: 'error', today: [], upcoming: [], error: e },
      };
    }
    store.setSection('comms', state);
  },
};

export default comms;
