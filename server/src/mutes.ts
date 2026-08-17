import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Mute, MuteKind, MuteRequest } from '../../shared/types.js';
import { config } from './config.js';
import { store } from './state.js';
import { iso, readJson, sh } from './util.js';
import { restartRevutoDaemon, runRevutoCli, systemctlUser } from './core/revuto-cli.js';

const FILE = join(config.configDir, 'mutes.json');

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const JOB_RE = /^[\w-]+$/;

const MUTE_KINDS: ReadonlySet<string> = new Set<MuteKind>([
  'github-item',
  'github-repo',
  'github-org',
  'github-reason',
  'github-author',
  'github-title',
  'agent',
  'agent-resource',
  'schedule',
  'service',
  'flag',
  'flag-source',
]);

/** github-item mutes whose item has been gone (closed/merged) this long are retired —
 *  the archive holds live rules, not tombstones. */
const ITEM_GONE_GRACE_MS = 7 * 86_400_000;
/** an until-clear flag mute younger than this survives a transiently-empty publish */
const FLAG_CLEAR_GRACE_MS = 5 * 60_000;

let current: Mute[] = [];

interface Adapter {
  enforcedBy: string;
  enforce(): Promise<void>;
  unenforce(): Promise<void>;
}

function systemctl(verb: 'start' | 'stop' | 'restart', unit: string): Promise<string> {
  return systemctlUser(verb, unit);
}

function hermesCronAdapter(jobId: string): Adapter | null {
  if (!JOB_RE.test(jobId)) return null;
  return {
    enforcedBy: 'hermes cli cron pause',
    enforce: async () => {
      await sh(config.paths.hermesCli, ['cron', 'pause', jobId]);
    },
    unenforce: async () => {
      await sh(config.paths.hermesCli, ['cron', 'resume', jobId]);
    },
  };
}

async function writeIdleWatcherSuppression(suppressedUntilEpochS: number): Promise<void> {
  const path = config.paths.idleWatcherState;
  // merge so last_ping (and anything else the watcher tracks) survives
  const existing = (await readJson<Record<string, unknown>>(path)) ?? {};
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify({ ...existing, suppressed_until: suppressedUntilEpochS }));
}

/** Returns the real-enforcement adapter for a mute, or null when only ui mode is possible. */
function adapterFor(kind: MuteKind, target: string, until: string | null): Adapter | null {
  // hermes cron jobs are reachable as both agent-resource and schedule targets
  if ((kind === 'agent-resource' || kind === 'schedule') && target.startsWith('hermes:')) {
    return hermesCronAdapter(target.slice('hermes:'.length));
  }

  if (kind === 'agent-resource' && target.startsWith('revuto:')) {
    const repo = target.slice('revuto:'.length);
    if (!REPO_RE.test(repo)) return null;
    return {
      enforcedBy: 'revuto cli pause + systemd restart',
      enforce: async () => {
        await runRevutoCli(['pause', repo]);
        await restartRevutoDaemon();
      },
      unenforce: async () => {
        await runRevutoCli(['resume', repo]);
        await restartRevutoDaemon();
      },
    };
  }

  if (kind === 'agent' && target === 'revuto') {
    return {
      enforcedBy: 'systemctl --user stop revuto.service',
      enforce: async () => { await systemctl('stop', 'revuto.service'); },
      unenforce: async () => { await systemctl('start', 'revuto.service'); },
    };
  }

  if (kind === 'agent' && target === 'hermes') {
    return {
      enforcedBy: 'systemctl --user stop hermes-gateway.service',
      enforce: async () => {
        await systemctl('stop', 'hermes-gateway.service');
      },
      unenforce: async () => {
        await systemctl('start', 'hermes-gateway.service');
      },
    };
  }

  if (kind === 'schedule' && target.startsWith('crontab:')) {
    // only the idle-watcher crontab entry has a suppression hook; other crontab lines stay ui-only.
    // crontab ids are command-derived slugs (schedule.ts cronId), so the script name appears in the id
    if (!/idle[-_](proactive[-_])?watcher/i.test(target)) return null;
    const untilMs = until !== null ? new Date(until).getTime() : NaN;
    const untilEpochS = Number.isFinite(untilMs)
      ? Math.floor(untilMs / 1000)
      : Math.floor(Date.now() / 1000) + 10 * 365 * 86400; // "forever" (or unparseable) = +10 years
    return {
      enforcedBy: 'idle-watcher state suppressed_until',
      enforce: () => writeIdleWatcherSuppression(untilEpochS),
      unenforce: () => writeIdleWatcherSuppression(0),
    };
  }

  if (kind === 'service') {
    if (!config.watchedUnits.includes(target)) return null; // arbitrary units are not enforceable
    return {
      enforcedBy: `systemctl --user stop ${target}`,
      enforce: async () => {
        await systemctl('stop', target);
      },
      unenforce: async () => {
        await systemctl('start', target);
      },
    };
  }

  // github-* kinds, 'flag', and anything unmatched: no source to pause
  return null;
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

async function persist(): Promise<void> {
  try {
    await mkdir(config.configDir, { recursive: true });
    await atomicWrite(FILE, JSON.stringify(current, null, 2));
  } catch (err) {
    console.error('[mutes] persist failed:', err instanceof Error ? err.message : err);
  }
}

async function unenforceBestEffort(mute: Mute): Promise<void> {
  if (mute.mode !== 'enforced') return;
  const adapter = adapterFor(mute.kind, mute.target, mute.until);
  if (!adapter) return;
  try {
    await adapter.unenforce();
  } catch (err) {
    console.error(`[mutes] un-enforce ${mute.id} failed:`, err instanceof Error ? err.message : err);
  }
}

async function sweepExpired(): Promise<void> {
  const now = Date.now();
  const activeFlagIds = new Set(store.get().flags.map((f) => f.id));
  const expired = current.filter(
    (m) =>
      (m.until !== null && new Date(m.until).getTime() <= now) ||
      // until-clear flag mutes lift once the flag stops being raised, so the next
      // real failure alerts again instead of dying against a forever-mute
      (m.kind === 'flag' &&
        m.untilClear === true &&
        !activeFlagIds.has(m.target) &&
        now - new Date(m.createdAt).getTime() > FLAG_CLEAR_GRACE_MS),
  );
  if (expired.length === 0) return;
  for (const m of expired) await unenforceBestEffort(m);
  const dead = new Set(expired.map((m) => m.id));
  current = current.filter((m) => !dead.has(m.id));
  await persist();
  store.setMutes(current);
}

const sweepTimer = setInterval(() => {
  void sweepExpired();
}, 60_000);
sweepTimer.unref();

export const mutes = {
  async load(): Promise<void> {
    try {
      await mkdir(config.configDir, { recursive: true });
      const saved = await readJson<Mute[]>(FILE);
      current = Array.isArray(saved)
        ? saved.filter((m): m is Mute => !!m && typeof m.id === 'string' && typeof m.target === 'string')
        : [];
    } catch (err) {
      console.error('[mutes] load failed:', err instanceof Error ? err.message : err);
      current = [];
    }
    await sweepExpired(); // also resumes anything that expired while the server was down
    store.setMutes(current);
  },

  /** Throws on invalid request shape — the HTTP layer maps that to 400. */
  async add(req: MuteRequest): Promise<Mute> {
    if (typeof req?.kind !== 'string' || !MUTE_KINDS.has(req.kind)) {
      throw new Error(`invalid mute kind: ${JSON.stringify(req?.kind)}`);
    }
    if (typeof req.target !== 'string' || req.target.trim() === '') {
      throw new Error('mute target must be a non-empty string');
    }
    const until = req.until ?? null;
    if (until !== null && (typeof until !== 'string' || Number.isNaN(Date.parse(until)))) {
      // NaN until would compare false in the expiry sweep forever — a typo becomes a silent forever-mute
      throw new Error(`invalid mute until (must be ISO timestamp or null): ${JSON.stringify(until)}`);
    }
    const id = `${req.kind}:${req.target}`;
    const existing = current.find((m) => m.id === id);
    let mode: Mute['mode'] = 'ui';
    let enforcedBy: string | null = null;
    if (req.enforce) {
      const adapter = adapterFor(req.kind, req.target, until);
      if (adapter) {
        try {
          await adapter.enforce();
          mode = 'enforced';
          enforcedBy = adapter.enforcedBy;
        } catch (err) {
          // adapter failure never rejects the mute — degrade to ui-only
          enforcedBy = `enforce failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
        }
      }
    }
    // replacing an enforced mute with a non-enforced one must not strand the source paused
    if (existing && existing.mode === 'enforced' && mode !== 'enforced') {
      await unenforceBestEffort(existing);
    }
    const mute: Mute = { id, kind: req.kind, target: req.target, until, mode, enforcedBy, createdAt: iso() };
    if (req.untilActivity === true && req.kind === 'github-item') mute.untilActivity = true;
    if (req.untilClear === true && req.kind === 'flag') mute.untilClear = true;
    current = [...current.filter((m) => m.id !== id), mute];
    await persist();
    store.setMutes(current);
    return mute;
  },

  /** Reconcile github-item mutes against a fresh poll. Three moves:
   *  - until-activity mutes whose item moved since the mute was set wake up
   *    (new comment/push bumps updatedAt → the item resurfaces)
   *  - mutes whose item is still visible get lastSeenAt stamped
   *  - mutes whose item has been gone past the grace window are retired — the
   *    item closed/merged, so the mute is a tombstone cluttering the archive */
  async resurface(items: ReadonlyMap<string, string | null>): Promise<void> {
    const now = Date.now();
    const nowIso = iso();
    let changed = false;
    const next: Mute[] = [];
    for (const m of current) {
      if (m.kind !== 'github-item') {
        next.push(m);
        continue;
      }
      const updatedAt = items.get(m.target);
      if (updatedAt !== undefined) {
        if (
          m.untilActivity === true &&
          !!updatedAt &&
          new Date(updatedAt).getTime() > new Date(m.createdAt).getTime()
        ) {
          changed = true; // woken — drop it
          continue;
        }
        // coarse stamp — re-persisting every 60s poll for a timestamp nobody reads
        // that precisely would churn the disk for nothing
        const lastStamp = new Date(m.lastSeenAt ?? 0).getTime();
        if (now - lastStamp > 6 * 3_600_000) {
          next.push({ ...m, lastSeenAt: nowIso });
          changed = true;
        } else next.push(m);
        continue;
      }
      const lastAlive = new Date(m.lastSeenAt ?? m.createdAt).getTime();
      if (now - lastAlive > ITEM_GONE_GRACE_MS) {
        changed = true; // retired — item long gone
        continue;
      }
      next.push(m);
    }
    if (!changed) return;
    current = next;
    await persist();
    store.setMutes(current);
  },

  async remove(id: string): Promise<void> {
    const mute = current.find((m) => m.id === id);
    if (!mute) return;
    await unenforceBestEffort(mute);
    current = current.filter((m) => m.id !== id);
    await persist();
    store.setMutes(current);
  },
};
