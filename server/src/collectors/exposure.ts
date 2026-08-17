// Exposure counters — the numbers other people keep for us, badly.
//
// GitHub's traffic API keeps FOURTEEN DAYS and returns only the top ten referrers.
// Hugging Face gives an individual account one rolling 30-day download number and no
// history at all. Both are the best evidence available about how a project is found,
// and both age out silently, so the only way to have a series is to write the number
// down before it disappears.
//
// WHY HERE AND NOT IN CI: the first version of this was a scheduled GitHub Actions
// job. Actions' built-in token is scoped to the repository it runs in, so reading
// another repo's traffic needed a personal access token parked in a hosted secret
// store — a new copy of a credential, in someone else's environment, to fetch numbers
// about ourselves. This machine already has `gh` authenticated. A daemon that already
// polls things on a schedule is the right place, and the credential stays where it
// already lives.
//
// The snapshot itself is written by an external script rather than reimplemented here,
// so there is exactly one definition of the file format: the same command can be run
// by hand, and this collector is only the scheduler and the display.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { signals } from '../signals.js';
import { sh } from '../util.js';
import type { SignalItem } from '../../../shared/types.js';
import type { Collector } from './registry.js';

interface ExposureConfig {
  /** argv of the snapshot writer, e.g. ["node", "/path/ops/analytics/snapshot.mjs"]. */
  command: string[];
  /** where that command writes <UTC-date>.json. */
  snapshotDir: string;
}

function settings(): ExposureConfig {
  const raw = (config as unknown as { exposure?: Partial<ExposureConfig> }).exposure ?? {};
  return {
    command: Array.isArray(raw.command) ? raw.command : [],
    snapshotDir: typeof raw.snapshotDir === 'string' ? raw.snapshotDir : '',
  };
}

interface Snapshot {
  date: string;
  repo: { stars: number; forks: number; watchers: number } | null;
  traffic: {
    views14d: { total: number; uniques: number } | null;
    clones14d: { total: number; uniques: number } | null;
    referrers: Array<{ referrer: string; count: number; uniques: number }> | null;
  };
  huggingface: Array<{ id: string; downloads30d: number | null; likes: number | null }>;
  crates: Array<{ name: string; totalDownloads: number | null; recentDownloads: number | null }>;
  notes: string[];
}

async function readSnapshot(dir: string, file: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(join(dir, file), 'utf8')) as Snapshot;
  } catch {
    return null; // the run failed, or it is the first cycle after midnight before a write
  }
}

/** newest dated snapshot strictly before `today` — the delta baseline */
async function previousSnapshot(dir: string, today: string): Promise<Snapshot | null> {
  try {
    const files = (await readdir(dir))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `${today}.json`)
      .sort();
    const last = files.at(-1);
    return last ? readSnapshot(dir, last) : null;
  } catch {
    return null;
  }
}

const collector: Collector = {
  name: 'exposure',
  // Six hours. The window being protected is fourteen days wide, so this is far more
  // often than the data needs — it is this frequent only so a machine that is off for
  // a day still records that day.
  intervalMs: 6 * 60 * 60_000,

  async run() {
    const { command, snapshotDir } = settings();

    if (command.length === 0 || !snapshotDir) {
      await signals.publish('exposure', [], null); // unconfigured is the fresh-install default
      return;
    }

    let stdout = '';
    let failure: string | null = null;
    try {
      // The script needs `gh` on PATH for the traffic endpoints; a systemd user unit
      // starts with a minimal one, so the usual locations are added explicitly rather
      // than left to chance — an absent `gh` silently costs the referrer table.
      stdout = await sh(command[0], command.slice(1), {
        timeoutMs: 120_000,
        env: {
          ...process.env,
          PATH: [process.env.PATH, `${process.env.HOME}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
            .filter(Boolean)
            .join(':'),
        },
      });
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 300) : String(error);
    }

    const today = new Date().toISOString().slice(0, 10);
    const [snapshot, previous] = await Promise.all([
      readSnapshot(snapshotDir, `${today}.json`),
      previousSnapshot(snapshotDir, today),
    ]);

    const items: Array<Omit<SignalItem, 'firstSeenAt'>> = [];
    if (snapshot) {
      const counter = (
        key: string,
        entity: string,
        title: string,
        count: number | null,
        prev: number | null | undefined,
        opts: { detail?: string | null; url?: string | null } = {},
      ) => {
        items.push({
          id: `exposure:${key}`,
          source: 'exposure',
          kind: 'counter',
          entity,
          title,
          detail: opts.detail ?? null,
          url: opts.url ?? null,
          count,
          // deltas compare against the previous recorded day — the whole point of
          // writing these down before the upstream window expires
          delta: count !== null && typeof prev === 'number' ? count - prev : null,
          occurredAt: snapshot.date ?? null,
        });
      };

      const views = snapshot.traffic.views14d;
      const clones = snapshot.traffic.clones14d;
      if (snapshot.repo) {
        counter('repo:stars', 'repo', 'stars', snapshot.repo.stars, previous?.repo?.stars, {
          detail: `${snapshot.repo.forks} forks · ${snapshot.repo.watchers} watching`,
        });
      }
      counter('traffic:views14d', 'repo', 'views, 14d', views?.total ?? null, previous?.traffic.views14d?.total, {
        detail: views ? `${views.uniques} unique` : 'not recorded — no gh token',
      });
      if (clones) {
        counter('traffic:clones14d', 'repo', 'clones, 14d', clones.total, previous?.traffic.clones14d?.total, {
          detail: `${clones.uniques} unique`,
        });
      }
      for (const model of snapshot.huggingface) {
        const prev = previous?.huggingface.find((m) => m.id === model.id);
        counter(`hf:${model.id}`, model.id.split('/').pop() ?? model.id, 'downloads, 30d', model.downloads30d, prev?.downloads30d, {
          detail: `${model.likes ?? 0} likes`,
          url: `https://huggingface.co/${model.id}`,
        });
      }
      for (const crate of snapshot.crates) {
        const prev = previous?.crates.find((c) => c.name === crate.name);
        counter(`crate:${crate.name}`, crate.name, 'crate downloads', crate.totalDownloads, prev?.totalDownloads, {
          detail: crate.recentDownloads !== null ? `${crate.recentDownloads} recent` : null,
          url: `https://crates.io/crates/${crate.name}`,
        });
      }
      // The reason the job exists: this table is gone in fourteen days.
      for (const referrer of (snapshot.traffic.referrers ?? []).slice(0, 5)) {
        const prev = previous?.traffic.referrers?.find((r) => r.referrer === referrer.referrer);
        counter(`referrer:${referrer.referrer}`, referrer.referrer, 'referrer views, 14d', referrer.count, prev?.count, {
          detail: `${referrer.uniques} unique`,
        });
      }
    }

    const error = failure ?? (snapshot ? null : `no snapshot for ${today} in ${snapshotDir}`);
    void stdout;
    await signals.publish('exposure', items, error);
  },
};

export default collector;
