// Exposure counters: the numbers other people keep for us, badly.
//
// GitHub's traffic API keeps FOURTEEN DAYS and returns only the top ten referrers.
// Hugging Face gives an individual account one rolling 30-day download number and no
// history at all. Both are the best evidence available about how your open-source work
// is found, and both age out silently, so the only way to have a series is to write the
// number down before it disappears.
//
// This is a personal counter for the owner's OSS projects, not a business surface: the
// business (tiyuvta) reports its reach in the CRM. The portfolio (repos, HF models,
// crates) is config (`exposure.portfolio`). The daily JSON files keep their format and
// directory, so every already-recorded day and its backups stay valid. A legacy external
// `exposure.command` still runs when the portfolio is empty, for forks that kept their
// own writer.
//
// Published to the plugin lane: summary rows with day-over-day deltas for the generic
// panel and MCP, and the full counter list (with 30-day spark series) in `data`.

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { writeExposureSnapshot, type ExposurePortfolio } from '../core/exposure-snapshot.js';
import { store } from '../state.js';
import { iso, sh } from '../util.js';
import type { ExtraRow } from '../../../shared/types.js';
import type { Collector } from './registry.js';

const TITLE = 'exposure';

function settings(): { command: string[]; snapshotDir: string; portfolio: ExposurePortfolio } {
  const raw = config.exposure;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    command: list(raw.command),
    snapshotDir: typeof raw.snapshotDir === 'string' ? raw.snapshotDir : '',
    portfolio: { repos: list(raw.portfolio?.repos), hfModels: list(raw.portfolio?.hfModels), crates: list(raw.portfolio?.crates) },
  };
}

/** One recorded number with its movement since the previous recorded day. */
export interface ExposureCounter {
  id: string;
  /** what the number belongs to: a repo, a model card, a crate, a referrer */
  entity: string;
  /** which number: stars, views 14d, downloads 30d, ... */
  title: string;
  detail: string | null;
  url: string | null;
  count: number | null;
  delta: number | null;
  /** oldest first, one point per recorded day, when at least two exist */
  spark?: number[];
  /** the snapshot date the number was read from */
  occurredAt: string | null;
}

const fmtCount = (n: number | null): string => (n === null ? 'not recorded' : n.toLocaleString('en-US'));
const fmtDelta = (d: number | null): string => (d === null || d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d.toLocaleString('en-US')})`);

function publish(items: ExposureCounter[], error: string | null, note?: string): void {
  const rows: ExtraRow[] = note
    ? [{ label: 'portfolio', value: note }]
    : items.slice(0, 40).map((i) => ({
        label: `${i.entity} · ${i.title}`,
        value: `${fmtCount(i.count)}${fmtDelta(i.delta)}`,
        href: i.url ?? undefined,
        tone: i.delta !== null && i.delta > 0 ? 'ok' : undefined,
      }));
  store.setExtra(TITLE, { title: TITLE, updatedAt: iso(), up: error === null, error, rows, data: { items } });
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
    const { command, snapshotDir, portfolio } = settings();
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
      publish([], null, 'not configured: set exposure.portfolio (repos, hfModels, crates)'); // the fresh-install default
      return;
    }

    const history = await recentSnapshots(dir);
    const snapshot = history.at(-1) ?? null;
    const previous = history.at(-2) ?? null;
    const fallbackRepo = portfolio.repos[0] ?? 'repo';

    const items: ExposureCounter[] = [];
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
        const hfOrg = portfolio.hfModels[0]?.split('/')[0] ?? null;
        counter('hf:quiet', `hf: ${quietCards.length} card(s) with no downloads/likes`, 'tracked, quiet', quietCards.length, undefined, {
          detail: quietCards.slice(0, 6).join(', ') + (quietCards.length > 6 ? ', ...' : ''),
          url: hfOrg ? `https://huggingface.co/${hfOrg}` : null,
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
    publish(items, error);
  },
};

export default collector;
