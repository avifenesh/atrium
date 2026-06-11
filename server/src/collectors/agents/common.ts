import type { AgentId, AgentInfo, Flag } from '../../../../shared/types.js';
import { iso } from '../../util.js';

export interface SourceResult {
  agent: AgentInfo;
  flags: Flag[];
}

export function baseAgent(id: AgentId, name: string): AgentInfo {
  return {
    id,
    name,
    status: 'unknown',
    detail: '',
    lastActivity: null,
    sessions: [],
    resources: [],
    controls: [],
    error: null,
  };
}

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// pin first-raise time per flag id so the 10s poll doesn't show flags perpetually "just raised"
const raisedAtPin = new Map<string, string>();

export function flag(id: string, severity: Flag['severity'], title: string, detail: string): Flag {
  const at = raisedAtPin.get(id) ?? iso();
  raisedAtPin.set(id, at);
  return { id, severity, title, detail, source: 'agents', raisedAt: at };
}

/** Drop pins for flags no longer raised — call once per agents collector run with the live id set. */
export function pruneFlagPins(liveIds: Set<string>): void {
  for (const id of raisedAtPin.keys()) {
    if (!liveIds.has(id)) raisedAtPin.delete(id);
  }
}

/** Accepts epoch s/ms/us/ns (unit inferred by magnitude) or ISO string — sources disagree;
 *  eigen daemon emits UnixNano (~1.8e18 live), which Date() rejects as out of range. */
export function tsToMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 1e17) return Math.round(v / 1e6); // ns
    if (v >= 1e14) return Math.round(v / 1e3); // us
    if (v < 1e11) return Math.round(v * 1000); // s
    return Math.round(v); // ms
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function tsToIso(v: unknown): string | null {
  const ms = tsToMs(v);
  return ms === null ? null : iso(ms);
}
