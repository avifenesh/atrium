// Exposure counters — the numbers other people keep for us, badly.
//
// GitHub's traffic API keeps FOURTEEN DAYS and returns only the top ten referrers.
// Hugging Face gives an individual account one rolling 30-day download number and no
// history at all. Both are the best evidence available about how the business is
// found, and both age out silently, so the only way to have a series is to write the
// number down before it disappears.
//
// The snapshot writer is native now (core/exposure-snapshot.ts, ported from the
// darklanes script): the portfolio — repos, HF models, crates — is business
// configuration and lives in the signals watch file, edited from the UI. The daily
// JSON files keep their format and directory, so every already-recorded day and its
// backups stay valid. A legacy external `exposure.command` still runs when the
// portfolio is empty, for forks that kept their own writer.
//
// Published as counter signals with day-over-day deltas plus a 30-day spark series,
// which is what the business board draws its trends from.

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { writeExposureSnapshot } from '../core/exposure-snapshot.js';
import { signals } from '../signals.js';
import { sh } from '../util.js';
import type { SignalItem } from '../../../shared/types.js';
import type { Collector } from './registry.js';

interface ExposureConfig {
  /** legacy: argv of an external snapshot writer — used only when the portfolio is empty */
  command: string[];
  /** where the daily <UTC-date>.json files live */
  snapshotDir: string;
}

function settings(): ExposureConfig {
  const raw = (config as unknown as { exposure?: Partial<ExposureConfig> }).exposure ?? {};
  return {
    command: Array.isArray(raw.command) ? raw.command : [],
    snapshotDir: typeof raw.snapshotDir === 'string' ? raw.snapshotDir : '',
  };
}

interface RepoEntry {
  repo?: string;
  stars: number;
  forks: number;
  watchers: number;
  traffic?: Snapshot['traffic'];
}

interface Snapshot {
  date: string;
  repo: { stars: number; forks: number; watchers: number } | null;
  traffic: {
    views14d: { total: number; uniques: number } | null;
    clones14d: { total: number; uniques: number } | null;
    referrers: Array<{ referrer: string; count: number; uniques: number }> | null;
  };
  repos?: Array<RepoEntry & { traffic: Snapshot['traffic'] }>;
  huggingface: Array<{ id: string; downloads30d: number | null; likes: number | null }>;
  crates: Array<{ name: string; totalDownloads: number | null; recentDownloads: number | null }>;
  notes: string[];
}

/** Normalize a snapshot into per-repo entries; legacy single-repo files attribute
 *  their top-level fields to the first watched repo. */
function repoEntries(snapshot: Snapshot, fallbackRepo: string): Array<{ repo: string; stars: number; forks: number; watchers: number; traffic: Snapshot['traffic'] }> {
  if (Array.isArray(snapshot.repos) && snapshot.repos.length > 0) {
    return snapshot.repos.map((r) => ({
      repo: r.repo ?? fallbackRepo,
      stars: r.stars,
      forks: r.forks,
      watchers: r.watchers,
      traffic: r.traffic ?? { views14d: null, clones14d: null, referrers: null },
    }));
  }
  if (snapshot.repo) {
    return [{ repo: fallbackRepo, ...snapshot.repo, traffic: snapshot.traffic }];
  }
  return [];
}

async function readSnapshot(dir: string, file: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(join(dir, file), 'utf8')) as Snapshot;
  } catch {
    return null; // the run failed, or it is the first cycle after midnight before a write
  }
}

const SPARK_DAYS = 30;

/** The recent history, oldest first — the whole reason the daily files exist. */
async function recentSnapshots(dir: string): Promise<Snapshot[]> {
  try {
    const files = (await readdir(dir))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .slice(-SPARK_DAYS);
    const parsed = await Promise.all(files.map((f) => readSnapshot(dir, f)));
    return parsed.filter((s): s is Snapshot => s !== null);
  } catch {
    return [];
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
    const watch = signals.watch();
    const portfolio = { repos: watch.repos, hfModels: watch.hfModels, crates: watch.crates };
    const configured = portfolio.repos.length + portfolio.hfModels.length + portfolio.crates.length > 0;
    const dir = snapshotDir || join(homedir(), '.local', 'share', 'atrium', 'exposure');

    let failure: string | null = null;
    if (configured) {
      try {
        const notes = await writeExposureSnapshot(dir, portfolio);
        if (notes.length) failure = notes.slice(0, 3).join(' | ');
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 300) : String(error);
      }
    } else if (command.length > 0 && snapshotDir) {
      try {
        // the legacy external writer needs `gh` on PATH; a systemd user unit starts
        // with a minimal one, so the usual locations are added explicitly
        await sh(command[0], command.slice(1), {
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
    } else {
      await signals.publish('exposure', [], null); // unconfigured is the fresh-install default
      return;
    }

    const history = await recentSnapshots(dir);
    const snapshot = history.at(-1) ?? null;
    const previous = history.at(-2) ?? null;
    const fallbackRepo = portfolio.repos[0] ?? 'repo';

    const items: Array<Omit<SignalItem, 'firstSeenAt'>> = [];
    if (snapshot) {
      // per-key day series across the recent files, oldest first — the trend spark
      const series = (pick: (s: Snapshot) => number | null | undefined): number[] =>
        history.map(pick).filter((v): v is number => typeof v === 'number');

      const counter = (
        key: string,
        entity: string,
        title: string,
        count: number | null,
        prev: number | null | undefined,
        opts: { detail?: string | null; url?: string | null; spark?: number[] } = {},
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
          spark: opts.spark && opts.spark.length >= 2 ? opts.spark : undefined,
          occurredAt: snapshot.date ?? null,
        });
      };

      for (const entry of repoEntries(snapshot, fallbackRepo)) {
        const prevEntry = previous ? repoEntries(previous, fallbackRepo).find((r) => r.repo === entry.repo) : undefined;
        const entrySeries = (pick: (r: ReturnType<typeof repoEntries>[number]) => number | null | undefined) =>
          series((s) => {
            const r = repoEntries(s, fallbackRepo).find((x) => x.repo === entry.repo);
            return r ? pick(r) : null;
          });
        counter(`${entry.repo}:stars`, entry.repo, 'stars', entry.stars, prevEntry?.stars, {
          detail: `${entry.forks} forks · ${entry.watchers} watching`,
          url: `https://github.com/${entry.repo}`,
          spark: entrySeries((r) => r.stars),
        });
        counter(
          `${entry.repo}:views14d`,
          entry.repo,
          'views, 14d',
          entry.traffic.views14d?.total ?? null,
          prevEntry?.traffic.views14d?.total,
          {
            detail: entry.traffic.views14d ? `${entry.traffic.views14d.uniques} unique` : 'not recorded — no gh token',
            spark: entrySeries((r) => r.traffic.views14d?.total),
          },
        );
        if (entry.traffic.clones14d) {
          counter(
            `${entry.repo}:clones14d`,
            entry.repo,
            'clones, 14d',
            entry.traffic.clones14d.total,
            prevEntry?.traffic.clones14d?.total,
            {
              detail: `${entry.traffic.clones14d.uniques} unique`,
              spark: entrySeries((r) => r.traffic.clones14d?.total),
            },
          );
        }
        // The reason the job exists: this table is gone in fourteen days.
        for (const referrer of (entry.traffic.referrers ?? []).slice(0, 5)) {
          const prevRef = prevEntry?.traffic.referrers?.find((r) => r.referrer === referrer.referrer);
          counter(`${entry.repo}:referrer:${referrer.referrer}`, referrer.referrer, 'referrer views, 14d', referrer.count, prevRef?.count, {
            detail: `${referrer.uniques} unique`,
          });
        }
      }
      // The snapshot now carries EVERY card under the account. A row per card
      // with movement; the quiet ones (0 downloads, 0 likes — training
      // checkpoints mostly) collapse into a counted line instead of 12 zero
      // rows, so nothing is dropped silently and nothing drowns the panel.
      const quietCards: string[] = [];
      for (const model of snapshot.huggingface) {
        if (!model.downloads30d && !model.likes) {
          quietCards.push(model.id.split('/').pop() ?? model.id);
          continue;
        }
        const prev = previous?.huggingface.find((m) => m.id === model.id);
        counter(`hf:${model.id}`, model.id.split('/').pop() ?? model.id, 'downloads, 30d', model.downloads30d, prev?.downloads30d, {
          detail: `${model.likes ?? 0} likes`,
          url: `https://huggingface.co/${model.id}`,
          spark: series((s) => s.huggingface.find((m) => m.id === model.id)?.downloads30d),
        });
      }
      if (quietCards.length) {
        counter('hf:quiet', `hf: ${quietCards.length} card(s) with no downloads/likes`, 'tracked, quiet', quietCards.length, undefined, {
          detail: quietCards.slice(0, 6).join(', ') + (quietCards.length > 6 ? ', …' : ''),
          url: 'https://huggingface.co/Avifenesh',
        });
      }
      for (const crate of snapshot.crates) {
        const prev = previous?.crates.find((c) => c.name === crate.name);
        counter(`crate:${crate.name}`, crate.name, 'crate downloads', crate.totalDownloads, prev?.totalDownloads, {
          detail: crate.recentDownloads !== null ? `${crate.recentDownloads} recent` : null,
          url: `https://crates.io/crates/${crate.name}`,
          spark: series((s) => s.crates.find((c) => c.name === crate.name)?.totalDownloads),
        });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const error = failure ?? (snapshot ? null : `no snapshot for ${today} in ${dir}`);
    await signals.publish('exposure', items, error);
  },
};

export default collector;
