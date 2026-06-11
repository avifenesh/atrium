import { EventEmitter } from 'node:events';
import type { Snapshot, SectionName, Flag, Mute } from '../../shared/types.js';
import { iso } from './util.js';
import { onFlagsChanged } from './notify.js';

/** Central store: collectors write sections, SSE clients subscribe to changes. */
class Store extends EventEmitter {
  private snapshot: Snapshot = emptySnapshot();
  private flagsBySource = new Map<string, Flag[]>();

  get(): Snapshot {
    return { ...this.snapshot, generatedAt: iso() };
  }

  setSection<K extends SectionName>(section: K, data: Snapshot[K]): void {
    (this.snapshot as any)[section] = data;
    this.emit('section', section, data);
  }

  /** Each collector owns its flag namespace; replaces its own flags wholesale. */
  setFlags(source: string, flags: Flag[]): void {
    this.flagsBySource.set(source, flags);
    const all: Flag[] = [];
    for (const fs of this.flagsBySource.values()) all.push(...fs);
    all.sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
    const prev = this.snapshot.flags;
    this.snapshot.flags = all;
    // push pings on raise transitions — never throws; no-op until index.ts inits it
    onFlagsChanged(prev, all, this.snapshot.mutes);
    this.emit('section', 'flags', all);
  }

  setMutes(mutes: Mute[]): void {
    this.snapshot.mutes = mutes;
    this.emit('section', 'mutes', mutes);
  }
}

function sevRank(s: Flag['severity']): number {
  return s === 'crit' ? 2 : s === 'warn' ? 1 : 0;
}

export function emptySnapshot(): Snapshot {
  return {
    generatedAt: iso(),
    github: {
      updatedAt: null, error: null, actNow: [], orgQueue: [], myPRs: [], mentions: [],
      teamQueue: [], notifications: [], ownRepos: [], rateLimit: null,
    },
    agents: { updatedAt: null, agents: [], activity: [], dispatches: [] },
    system: {
      updatedAt: null,
      cpu: { load1: 0, load5: 0, load15: 0, cores: 0, pct: 0 },
      mem: { totalB: 0, availableB: 0, usedPct: 0 },
      swap: { totalB: 0, freeB: 0, usedPct: 0 },
      gpu: null, disks: [], ports: [], processes: [], services: [],
      history: { cpu: [], mem: [], swap: [], gpu: [] }, error: null,
    },
    schedule: { updatedAt: null, entries: [], error: null },
    comms: {
      updatedAt: null,
      google: { connected: false, source: null, hint: null },
      email: { status: 'disabled', unreadCount: 0, threads: [], error: null },
      calendar: { status: 'disabled', today: [], upcoming: [], error: null },
    },
    subs: { updatedAt: null, services: [], error: null },
    notes: { updatedAt: null, vaultPath: null, recent: [], error: null },
    surreal: { updatedAt: null, up: false, endpoint: '', version: null, namespaces: [], error: null },
    revuto: {
      updatedAt: null, up: false, counts: null, schedules: null, limits: null, store: null,
      services: [], models: [], reviewers: [], jobs: [], logs: [], error: null,
    },
    itch: {
      updatedAt: null, up: false, runs: [],
      research: { running: false, started: null, savedStem: null, killedReason: null },
      ratedTotal: null, error: null,
    },
    cloud: { updatedAt: null, instances: [], totalMonthlyUsd: null, error: null },
    mutes: [],
    flags: [],
  };
}

export const store = new Store();
