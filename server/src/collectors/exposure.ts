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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso, sh } from '../util.js';
import type { ExtraRow } from '../../../shared/types.js';
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

const collector: Collector = {
  name: 'exposure',
  // Six hours. The window being protected is fourteen days wide, so this is far more
  // often than the data needs — it is this frequent only so a machine that is off for
  // a day still records that day.
  intervalMs: 6 * 60 * 60_000,

  async run() {
    const { command, snapshotDir } = settings();
    const now = iso();

    if (command.length === 0 || !snapshotDir) {
      store.setExtra('exposure', {
        title: 'exposure',
        updatedAt: now,
        up: true,
        rows: [{ label: 'not configured', value: 'set exposure.command and exposure.snapshotDir', tone: 'warn' }],
        error: null,
      });
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
    let snapshot: Snapshot | null = null;
    try {
      snapshot = JSON.parse(await readFile(join(snapshotDir, `${today}.json`), 'utf8')) as Snapshot;
    } catch {
      /* the run failed, or it is the first cycle after midnight before a write */
    }

    const rows: ExtraRow[] = [];
    if (snapshot) {
      const views = snapshot.traffic.views14d;
      const clones = snapshot.traffic.clones14d;
      if (snapshot.repo) {
        rows.push({
          label: 'repo',
          value: `${snapshot.repo.stars} stars · ${snapshot.repo.forks} forks · ${snapshot.repo.watchers} watching`,
        });
      }
      rows.push({
        label: 'views, 14d',
        value: views ? `${views.total} · ${views.uniques} unique` : 'not recorded — no gh token',
        tone: views ? undefined : 'warn',
      });
      if (clones) rows.push({ label: 'clones, 14d', value: `${clones.total} · ${clones.uniques} unique` });
      for (const model of snapshot.huggingface) {
        rows.push({
          label: `  hf ${model.id.split('/').pop()}`,
          value: `${model.downloads30d ?? '?'} downloads/30d · ${model.likes ?? 0} likes`,
          href: `https://huggingface.co/${model.id}`,
        });
      }
      for (const crate of snapshot.crates) {
        rows.push({ label: `  crate ${crate.name}`, value: `${crate.totalDownloads ?? '?'} total · ${crate.recentDownloads ?? '?'} recent` });
      }
      // The reason the job exists: this table is gone in fourteen days.
      for (const referrer of (snapshot.traffic.referrers ?? []).slice(0, 5)) {
        rows.push({ label: `  ↳ ${referrer.referrer}`, value: `${referrer.count} views · ${referrer.uniques} unique` });
      }
      if (snapshot.notes.length) {
        rows.push({ label: 'notes', value: snapshot.notes[0].slice(0, 90), tone: 'warn' });
      }
    }

    store.setExtra('exposure', {
      title: 'exposure',
      updatedAt: now,
      up: failure === null,
      rows,
      error: failure ?? (snapshot ? null : `no snapshot for ${today} in ${snapshotDir}`),
      data: snapshot ? { date: snapshot.date, lastLine: stdout.trim().split('\n').pop() } : undefined,
    });
  },
};

export default collector;
