import { useEffect, useRef, useState } from 'react';
import type { Snapshot, MuteRequest, Mute, SectionName } from '../../shared/types';

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
          section: SectionName | 'mutes' | 'flags';
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

/** True when this target (or its org for repos) is muted. */
export function isMuted(snapshot: Snapshot, kind: string, target: string): boolean {
  const now = Date.now();
  return snapshot.mutes.some((m) => {
    if (m.until && new Date(m.until).getTime() < now) return false;
    if (m.kind === kind && m.target === target) return true;
    if (kind === 'github-repo' && m.kind === 'github-org' && target.startsWith(`${m.target}/`)) return true;
    return false;
  });
}
