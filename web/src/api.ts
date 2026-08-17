import { useEffect, useRef, useState } from 'react';
import type {
  Snapshot,
  MuteRequest,
  Mute,
  SectionName,
  GithubItemDetail,
  GithubComment,
  ReentryContext,
  ReentryEnergy,
  HelperExecutor,
  HelperOffer,
  HelperSettings,
  SignalsWatch,
} from '../../shared/types';

const BASE = ''; // same origin (vite proxies /api in dev)

export async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch(`${BASE}/api/snapshot`);
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

export async function addMute(req: MuteRequest): Promise<Mute> {
  const res = await fetch(`${BASE}/api/mutes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`mute failed ${res.status}`);
  return res.json();
}

export async function removeMute(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/mutes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`unmute failed ${res.status}`);
}

export async function agentAction(agentId: string, action: string, target?: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const res = await fetch(`${BASE}/api/agents/${agentId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  return res.json();
}

export async function refreshSection(section: string): Promise<void> {
  await fetch(`${BASE}/api/refresh/${section}`, { method: 'POST' });
}

async function systemPortRequest<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `port request failed ${res.status}`);
  return data as T;
}

export function teachPort(port: number, label?: string): Promise<{ ok: boolean; port: number; label: string }> {
  return systemPortRequest('/api/system/ports/teach', { port, label });
}

export function stopPort(port: number): Promise<{ ok: boolean; port: number; pid: number }> {
  return systemPortRequest('/api/system/ports/stop', { port });
}

export async function fetchDispatchLog(id: string): Promise<string> {
  const res = await fetch(`${BASE}/api/grok/dispatch/${encodeURIComponent(id)}/log`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `dispatch log failed ${res.status}`);
  return typeof data?.log === 'string' ? data.log : '';
}

async function reentryRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `re-entry request failed ${res.status}`);
  return data as T;
}

export function parkReentry(req: {
  path: string;
  title?: string;
  note?: string;
  energy?: ReentryEnergy;
}): Promise<ReentryContext> {
  return reentryRequest('/api/reentry/park', req);
}

export function resumeReentry(id: string): Promise<{ context: ReentryContext; launched: boolean; via: string }> {
  return reentryRequest(`/api/reentry/${encodeURIComponent(id)}/resume`);
}

export function archiveReentry(id: string): Promise<ReentryContext> {
  return reentryRequest(`/api/reentry/${encodeURIComponent(id)}/archive`);
}

export function scanReentry(): Promise<{ ok: boolean; scheduled: boolean }> {
  return reentryRequest('/api/reentry/scan');
}

async function helperRequest<T>(path: string, method = 'POST', body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `helper request failed ${res.status}`);
  return data as T;
}

export function scanHelper(): Promise<{ ok: boolean; scheduled: boolean }> {
  return helperRequest('/api/helper/scan');
}

export function dismissHelperOffer(id: string, reason: string, remember: boolean): Promise<HelperOffer> {
  return helperRequest(`/api/helper/offers/${encodeURIComponent(id)}/dismiss`, 'POST', { reason, remember });
}

export function snoozeHelperOffer(id: string, durationMs = 24 * 60 * 60_000): Promise<HelperOffer> {
  return helperRequest(`/api/helper/offers/${encodeURIComponent(id)}/snooze`, 'POST', { durationMs });
}

export function launchHelperOffer(
  id: string,
  executor: HelperExecutor,
  prompt: string,
): Promise<{ offer: HelperOffer; launched: true; executor: HelperExecutor }> {
  return helperRequest(`/api/helper/offers/${encodeURIComponent(id)}/launch`, 'POST', { executor, prompt });
}

export function updateHelperSettings(settings: HelperSettings): Promise<HelperSettings> {
  return helperRequest('/api/helper/settings', 'POST', settings);
}

export function removeHelperMemory(kind: 'preferences' | 'skills', id: string): Promise<{ ok: true }> {
  return helperRequest(`/api/helper/${kind}/${encodeURIComponent(id)}`, 'DELETE');
}

/** Open a task in grok. Pass url/repo when dispatching a github item. */
export async function dispatchToEigen(req: {
  title: string;
  prompt?: string;
  url?: string;
  repo?: string;
  sourceId?: string;
}): Promise<{ id: string; mode: string } | { error: string }> {
  const res = await fetch(`${BASE}/api/grok/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  return res.json();
}

export async function clearNotification(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/notifications/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`clear failed ${res.status}`);
}

export async function clearAllNotifications(): Promise<void> {
  const res = await fetch(`${BASE}/api/notifications/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  if (!res.ok) throw new Error(`clear all failed ${res.status}`);
}

export interface NoteContent {
  root: string;
  path: string;
  title: string;
  content: string;
  modifiedAt: string;
}

/** Fetch one note's markdown for the in-app reader. Throws the server's error message on failure. */
export async function fetchNote(relPath: string, root = 'vault'): Promise<NoteContent> {
  const res = await fetch(`${BASE}/api/notes/read?path=${encodeURIComponent(relPath)}&root=${encodeURIComponent(root)}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `note read failed ${res.status}`);
  return body as NoteContent;
}

/** Thrown by saveNote when the file changed on disk since it was opened (HTTP 409).
 *  The panel detects this to offer reload-vs-overwrite instead of a plain error. */
export class NoteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteConflictError';
  }
}

/** Save a note back to the vault. Pass baseModifiedAt to guard against a concurrent
 *  edit on disk (omit it to force an overwrite). Resolves to the new mtime; throws the
 *  server's error message on failure, or a typed NoteConflictError on 409. */
export async function saveNote(
  relPath: string,
  content: string,
  baseModifiedAt?: string,
  root = 'vault',
): Promise<{ modifiedAt: string }> {
  const res = await fetch(`${BASE}/api/notes/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: relPath, content, baseModifiedAt, root }),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 409) throw new NoteConflictError(body?.error ?? 'file changed on disk');
  if (!res.ok) throw new Error(body?.error ?? `note write failed ${res.status}`);
  return { modifiedAt: body.modifiedAt as string };
}

/** Fetch one github issue/PR with its comment thread for the in-app reader.
 *  Throws the server's error message on failure. */
export async function fetchGithubItem(repo: string, number: number): Promise<GithubItemDetail> {
  const res = await fetch(`${BASE}/api/github/item?repo=${encodeURIComponent(repo)}&number=${number}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `github item failed ${res.status}`);
  return body as GithubItemDetail;
}

/** Post a comment to an issue/PR. Returns the created comment for optimistic append.
 *  Throws the server's error message on failure. */
export async function postGithubComment(
  repo: string,
  number: number,
  body: string,
): Promise<{ comment: GithubComment }> {
  const res = await fetch(`${BASE}/api/github/comment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, number, body }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data?.comment) throw new Error(data?.error ?? `comment failed ${res.status}`);
  return { comment: data.comment as GithubComment };
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES';

/** Submit a PR review. Mirrors postGithubComment; returns the review for optimistic append. */
export async function postGithubReview(
  repo: string,
  number: number,
  event: ReviewEvent,
  body?: string,
): Promise<{ review: GithubComment }> {
  const res = await fetch(`${BASE}/api/github/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, number, event, body }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data?.review) throw new Error(data?.error ?? `review failed ${res.status}`);
  return { review: data.review as GithubComment };
}

/** Start the in-app google connect flow: opens consent in a new tab. */
export async function connectGoogle(): Promise<void> {
  const res = await fetch(`${BASE}/api/google/auth-url`);
  const body = await res.json();
  if (!res.ok || !body.url) throw new Error(body.error ?? 'auth-url failed');
  window.open(body.url, '_blank', 'noopener');
}

/** One-time spotify setup: store the developer-app Client ID server-side. */
export async function spotifySetClient(clientId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/spotify/client`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `save failed ${res.status}`);
  }
}

/** Start the in-app spotify connect flow (PKCE): opens consent in a new tab. */
export async function connectSpotify(): Promise<void> {
  const res = await fetch(`${BASE}/api/spotify/auth-url`);
  const body = await res.json();
  if (!res.ok || !body.url) throw new Error(body.error ?? 'auth-url failed');
  window.open(body.url, '_blank', 'noopener');
}

/** Live snapshot via SSE with auto-reconnect. Single subscription for the whole app. */
export function useSnapshot(): { snapshot: Snapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const snapRef = useRef<Snapshot | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource(`${BASE}/api/stream`);
      es.addEventListener('snapshot', (e) => {
        snapRef.current = JSON.parse((e as MessageEvent).data);
        setSnapshot(snapRef.current);
        setConnected(true);
      });
      es.addEventListener('section', (e) => {
        const { section, data } = JSON.parse((e as MessageEvent).data) as {
          section: SectionName | 'extra' | 'collectors' | 'mutes' | 'flags';
          data: unknown;
        };
        if (!snapRef.current) return;
        snapRef.current = { ...snapRef.current, [section]: data, generatedAt: new Date().toISOString() };
        setSnapshot(snapRef.current);
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);

  return { snapshot, connected };
}

/** github-title mute targets are substrings, or /regex/ when slash-wrapped */
function titleMatches(pattern: string, title: string): boolean {
  const m = pattern.match(/^\/(.+)\/(i?)$/);
  if (m) {
    try {
      return new RegExp(m[1], m[2]).test(title);
    } catch {
      return false; // a broken regex mutes nothing rather than everything
    }
  }
  return title.toLowerCase().includes(pattern.toLowerCase());
}

/** True when this target is muted — cascades: item ⊂ repo ⊂ org, plus rule mutes
 *  (author / title pattern) when the caller passes the item's metadata. */
export function isMuted(
  snapshot: Snapshot,
  kind: string,
  target: string,
  meta?: { author?: string | null; title?: string },
): boolean {
  const now = Date.now();
  const repo = kind === 'github-item' ? target.split('#')[0] : kind === 'github-repo' ? target : null;
  const author = meta?.author?.toLowerCase().replace(/\[bot\]$/, '') ?? null;
  return snapshot.mutes.some((m) => {
    if (m.until && new Date(m.until).getTime() < now) return false;
    if (m.kind === kind && m.target === target) return true;
    // a source-level quiet (target e.g. "system") mutes every flag whose id is "system:…"
    if (kind === 'flag' && m.kind === 'flag-source' && target.startsWith(`${m.target}:`)) return true;
    if (repo !== null) {
      if (m.kind === 'github-repo' && m.target === repo) return true;
      if (m.kind === 'github-org' && repo.startsWith(`${m.target}/`)) return true;
    }
    if (kind === 'github-item') {
      // one rule instead of 53 hand mutes: quiet an author (dependabot) or a title shape
      if (m.kind === 'github-author' && author !== null && m.target.toLowerCase().replace(/\[bot\]$/, '') === author)
        return true;
      if (m.kind === 'github-title' && meta?.title && titleMatches(m.target, meta.title)) return true;
    }
    return false;
  });
}

/** Advance the signals "new since review" clock to now. */
export async function markSignalsReviewed(): Promise<void> {
  const res = await fetch(`${BASE}/api/signals/reviewed`, { method: 'POST' });
  if (!res.ok) throw new Error(`mark reviewed failed ${res.status}`);
}

/** Save the signals watch config (partial — only the provided arrays change). */
export async function saveSignalsWatch(patch: Partial<SignalsWatch>): Promise<SignalsWatch> {
  const res = await fetch(`${BASE}/api/signals/watch`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `watch save failed ${res.status}`);
  return body.watch as SignalsWatch;
}
