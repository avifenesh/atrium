// Serving alerts — the rig's serving watchdog, paged to the phone and rendered on the CRM.
//
// darklanes' `ops/serving/sentinel.py` runs every 60s from a pinned snapshot and probes
// every serving stack and website hostname from outside. Until 2026-08-23 its alerts were a
// desktop `notify-send`, a log line and a nonzero exit — none of which reach an owner who is
// not sitting at the rig, which is most of the time. It now also appends every alert to an
// append-only ledger; this collector is the reader.
//
// WHY A FILE AND NOT AN INGEST ROUTE. The sentinel is a watchdog: its tick must not
// depend on this daemon being up (the same reasoning that keeps `git fetch` out of its
// tick). A POST would also be LOSSY — an atrium restart would silently discard the alerts
// raised during it, which is the exact silent-failure class being fixed here. The ledger
// is durable, readable by hand when atrium is down, and needs no new write surface.
//
// WHAT PAGES. Open warn/crit incidents become flags, and crit flags ride the notify pipe
// that already pages Telegram for endpoint-down. No second pager is built here: the
// escalation, throttling, muting and [clear]-on-recovery all belong to notify.ts.
//
// ONE INCIDENT, NOT N ROWS. The sentinel's ladder deliberately re-pages a persisting
// condition (1, 5, 15, 30, 60, 120 ticks, then every 120), so a day-long outage emits 17
// alerts. Those collapse here on the event's stable `key` — never its title, which
// carries the streak and therefore changes on every rung. One flag id per episode means
// notify.ts pages once and sends one matching [clear].

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Flag, ServingIncident, ServingSnapshot } from '../../../shared/types.js';
import type { Collector } from './registry.js';

/** The sentinel's own vocabulary for severity. */
const SEVERITY: Record<string, Flag['severity']> = { critical: 'crit', warn: 'warn', info: 'info' };
const SEV_RANK: Record<Flag['severity'], number> = { info: 0, warn: 1, crit: 2 };

/** Bodies are already capped and credential-scrubbed by the sentinel; this is a second
 *  ceiling so a malformed line cannot push a megabyte into the snapshot. */
const TEXT_CAP = 1000;

interface AlertEvent {
  ts: string;
  event: 'raise' | 'resolve' | 'notice';
  level: string;
  key: string;
  title: string;
  body: string;
}

function stateDir(): string {
  return config.serving.stateDir || join(homedir(), '.local', 'state', 'tiyuvta-serving');
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, TEXT_CAP) : '';
}

/** Exported for the tests: the sentinel appends while this reads, so a torn final line
 *  must cost that line and nothing else. A pager that throws on a partial write is a
 *  pager that stops. */
export function parseEvent(line: string): AlertEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null; // a torn last line during an append — the next poll sees it whole
  }
  const d = raw as Partial<AlertEvent> | null;
  if (!d || typeof d.key !== 'string' || !d.key || typeof d.ts !== 'string') return null;
  const event = d.event === 'resolve' || d.event === 'notice' ? d.event : 'raise';
  return {
    ts: d.ts,
    event,
    level: typeof d.level === 'string' ? d.level : 'info',
    key: d.key.slice(0, 200),
    title: clean(d.title),
    body: clean(d.body),
  };
}

/** `<stack>:edge-down` → scope '<stack>', kind 'edge-down'. A notice keyed per occurrence
 *  (`<stack>:restarts-cumulative:50`) keeps the occurrence in the kind, so two milestones are
 *  two rows — which is what a milestone means. */
function split(key: string): { scope: string; kind: string } {
  const at = key.indexOf(':');
  if (at < 0) return { scope: 'sentinel', kind: key };
  return { scope: key.slice(0, at), kind: key.slice(at + 1) };
}

/**
 * Fold the event log into incidents. Exported for the tests: this is the whole
 * collapse-and-clear contract, and it must be assertable without a filesystem.
 *
 * Rules, each earning its place:
 *  - A `raise` on an already-open key ESCALATES it (max severity wins, latest title/detail
 *    shows, `pages` counts the rungs). It never adds a row.
 *  - A `raise` after a resolve starts a NEW episode: firstAt and the page count reset, so
 *    "down for 6h" can never be a stale reading from yesterday's outage.
 *  - A `resolve` for a key never raised is DROPPED. The sentinel closes both `paused` and
 *    `pause-expired` when a pause lifts without knowing which it had raised, and a
 *    tolerant reader is cheaper than making the writer track that.
 *  - A `notice` (a milestone crossed, a version change, a new Xid count) has no
 *    "still happening" state, so it expires on a clock instead of waiting for a resolve
 *    that will never come.
 */
export function foldIncidents(events: AlertEvent[], now: number, noticeTtlMs: number): ServingIncident[] {
  const byKey = new Map<string, ServingIncident & { notice: boolean }>();
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const severity = SEVERITY[e.level] ?? 'info';
    const existing = byKey.get(e.key);

    if (e.event === 'resolve') {
      if (!existing || !existing.open) continue;
      existing.open = false;
      existing.resolvedAt = e.ts;
      existing.lastAt = e.ts;
      existing.clearedBy = e.body || e.title;
      continue;
    }

    if (!existing || !existing.open) {
      const { scope, kind } = split(e.key);
      byKey.set(e.key, {
        key: e.key,
        scope,
        kind,
        severity,
        title: e.title,
        detail: e.body,
        firstAt: e.ts,
        lastAt: e.ts,
        pages: 1,
        open: true,
        resolvedAt: null,
        clearedBy: null,
        notice: e.event === 'notice',
      });
      continue;
    }
    existing.lastAt = e.ts;
    existing.pages += 1;
    existing.title = e.title;
    existing.detail = e.body;
    if (SEV_RANK[severity] > SEV_RANK[existing.severity]) existing.severity = severity;
    if (e.event === 'notice') existing.notice = true;
  }

  const out: ServingIncident[] = [];
  for (const inc of byKey.values()) {
    const { notice, ...rest } = inc;
    // A notice closes itself. Without this a "version changed" or a restart milestone
    // would sit open forever and every one of them would be a permanent flag.
    if (notice && rest.open && now - Date.parse(rest.lastAt) > noticeTtlMs) {
      rest.open = false;
      rest.resolvedAt = new Date(Date.parse(rest.lastAt) + noticeTtlMs).toISOString();
      rest.clearedBy = 'point-in-time notice, expired';
    }
    out.push(rest);
  }
  // open first, then worst, then newest — the phone screen shows the top
  return out.sort(
    (a, b) =>
      Number(b.open) - Number(a.open) ||
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      b.lastAt.localeCompare(a.lastAt),
  );
}

/**
 * Flags for the open incidents. warn and crit only: an info notice ("version changed",
 * "deploy in progress") is a record, not an interruption, and a flag strip that carries
 * them stops being read.
 *
 * The id is the sentinel's own key, so it is stable across the whole ladder — which is
 * what makes notify.ts page once per episode and send one matching [clear] — and it is
 * also what a `flag` mute has to match, so muting `serving:<stack>:capture` keeps working
 * across restarts of everything involved.
 */
export function incidentFlags(incidents: ServingIncident[]): Flag[] {
  return incidents
    .filter((i) => i.open && i.severity !== 'info')
    .map((i) => ({
      id: `serving:${i.key}`,
      severity: i.severity,
      title: i.title || `${i.scope} ${i.kind}`,
      detail: i.pages > 1 ? `${i.detail} · ${i.pages} alerts since ${i.firstAt}` : i.detail,
      source: 'serving',
      raisedAt: i.firstAt,
    }));
}

/**
 * THE WATCHDOG'S WATCHDOG. A pager fed by a file is silent in two indistinguishable
 * situations: nothing is wrong, and the writer is dead. The sentinel rewrites state.json
 * every single tick, so its mtime is a heartbeat — and a missing heartbeat is a crit,
 * because it means nothing is watching the boxes that take the money.
 */
function heartbeatFlag(tickAgeMs: number | null, silentAfterMs: number): Flag[] {
  if (tickAgeMs !== null && tickAgeMs <= silentAfterMs) return [];
  const detail =
    tickAgeMs === null
      ? `no state file at ${stateDir()} — the serving sentinel has never run here, so every serving stack is unwatched. Check tiyuvta-serving-sentinel.timer`
      : `last tick ${Math.round(tickAgeMs / 60_000)} min ago against a 60s timer — the serving watchdog has stopped, so an outage would now be silent. Check tiyuvta-serving-sentinel.timer`;
  return [
    {
      id: 'serving:sentinel-silent',
      severity: 'crit',
      title: 'serving sentinel is not ticking',
      detail,
      source: 'serving',
      raisedAt: iso(),
    },
  ];
}

async function tickAge(): Promise<number | null> {
  try {
    return Date.now() - (await stat(join(stateDir(), 'state.json'))).mtimeMs;
  } catch {
    return null;
  }
}

/** Snapshot for the CRM. Only the alert events and the tick age — deliberately NOT the
 *  fleet roster, which carries ssh endpoints and host provider addresses that have no
 *  business rendering on a surface that leaves the machine. */
export function snapshotOf(incidents: ServingIncident[], tickAgeMs: number | null): ServingSnapshot {
  const open = incidents.filter((i) => i.open);
  return {
    updatedAt: iso(),
    tickAgeS: tickAgeMs === null ? null : Math.round(tickAgeMs / 1000),
    openCrit: open.filter((i) => i.severity === 'crit').length,
    openWarn: open.filter((i) => i.severity === 'warn').length,
    // an incident list, capped: 40 rows is far more than a healthy fleet ever has, and a
    // storm must not put a megabyte through /api/crm/overview
    incidents: incidents.slice(0, 40),
  };
}

const collector: Collector = {
  name: 'serving',
  // A third of the sentinel's own 60s cadence: the added latency between an alert being
  // written and the phone ringing is bounded by this, and the read is one small file.
  intervalMs: 30_000,

  async run() {
    const dir = stateDir();
    const tickAgeMs = await tickAge();

    let events: AlertEvent[] = [];
    let readError: string | null = null;
    try {
      const text = await readFile(join(dir, 'alerts.jsonl'), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const parsed = parseEvent(line);
        if (parsed) events.push(parsed);
      }
    } catch (err) {
      // No ledger yet is the normal state of a fresh install, and it is NOT an error —
      // but it is also not evidence of health, which is what the heartbeat flag is for.
      if ((err as { code?: string }).code !== 'ENOENT') {
        readError = err instanceof Error ? err.message : String(err);
      }
    }

    const incidents = foldIncidents(events, Date.now(), config.serving.noticeTtlMs);
    const snapshot = snapshotOf(incidents, tickAgeMs);
    const open = incidents.filter((i) => i.open && i.severity !== 'info');

    store.setExtra('serving', {
      title: 'serving alerts',
      updatedAt: snapshot.updatedAt,
      up: readError === null && open.every((i) => i.severity !== 'crit') && snapshot.tickAgeS !== null,
      error: readError,
      rows: [
        {
          label: 'sentinel tick',
          value: snapshot.tickAgeS === null ? 'never — not running' : `${snapshot.tickAgeS}s ago`,
          tone:
            snapshot.tickAgeS === null || snapshot.tickAgeS * 1000 > config.serving.silentAfterMs
              ? 'err'
              : 'ok',
        },
        ...(open.length === 0
          ? [{ label: 'open incidents', value: 'none', tone: 'ok' as const }]
          : open.map((i) => ({
              label: `${i.scope} · ${i.kind}`,
              value: `${i.severity} · ${i.pages} alert${i.pages === 1 ? '' : 's'} since ${i.firstAt} — ${i.detail}`,
              tone: (i.severity === 'crit' ? 'err' : 'warn') as 'err' | 'warn',
            }))),
      ],
      data: snapshot,
    });

    store.setFlags('serving', [
      ...heartbeatFlag(tickAgeMs, config.serving.silentAfterMs),
      ...incidentFlags(incidents),
    ]);
  },
};

export default collector;
