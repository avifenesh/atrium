// Native exposure snapshotter — the daily write-down of counters other services
// own and will not keep for us. GitHub's traffic API keeps FOURTEEN DAYS and only
// the top ten referrers/paths; Hugging Face gives one rolling 30-day download
// number and no history. An unrecorded day is not late, it is gone.
//
// This started life as darklanes/ops/analytics/snapshot.mjs. It lives in atrium now
// because the portfolio (repos, HF models, crates) is business configuration, not a
// script constant in another repo — it comes from the signals watch file and is
// edited from the UI. The FILE FORMAT is unchanged and the merge rules are kept:
// one JSON per UTC date, merge-never-clobber (a tokenless run must not reduce a
// snapshot that already captured the referrer table), notes describe THIS run.
// Multi-repo is additive: the legacy top-level repo/traffic fields mirror the first
// watched repo so every older snapshot and reader stays valid.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { shTry } from '../util.js';

export interface ExposurePortfolio {
  repos: string[];
  hfModels: string[];
  crates: string[];
}

interface RepoTraffic {
  views14d: { total: number; uniques: number; daily?: unknown } | null;
  clones14d: { total: number; uniques: number; daily?: unknown } | null;
  referrers: Array<{ referrer: string; count: number; uniques: number }> | null;
  paths: Array<{ path: string; title: string; count: number; uniques: number }> | null;
}

interface RepoSnapshot {
  repo: string;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number | null;
  pushedAt: string | null;
  traffic: RepoTraffic;
}

async function githubToken(): Promise<string | null> {
  if (process.env.MEMRA_TRAFFIC_TOKEN) return process.env.MEMRA_TRAFFIC_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // a file the background service can always read comes before the gh keyring —
  // the keyring needs the D-Bus session address a long-lived unit may not have
  try {
    const text = await readFile(resolve(homedir(), '.config/tiyuvta/github.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?(GITHUB_TOKEN|GH_TOKEN)\s*=\s*(.*)$/u);
      if (match) {
        const value = match[2].trim().replace(/^["']|["']$/gu, '');
        if (value) return value;
      }
    }
  } catch {
    /* fall through to the CLI */
  }
  const out = await shTry('gh', ['auth', 'token'], { timeoutMs: 10_000 });
  return out?.match(/\S+/u)?.[0] ?? null;
}

async function getJson<T>(url: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = { 'user-agent': 'atrium-exposure-snapshot' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${response.status} ${url.replace(/^https:\/\//u, '')}`);
  return (await response.json()) as T;
}

/** Never let one dead endpoint cost the whole snapshot. */
async function attempt<T>(label: string, fn: () => Promise<T>, notes: string[]): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    notes.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const keep = <T>(next: T | null | undefined, old: T | null | undefined): T | null =>
  next === null || next === undefined ? (old ?? null) : next;

async function fetchRepo(repo: string, token: string | null, notes: string[]): Promise<RepoSnapshot | null> {
  const api = 'https://api.github.com';
  const [meta, views, clones, referrers, paths] = await Promise.all([
    attempt(`repo:${repo}`, () => getJson<any>(`${api}/repos/${repo}`, token), notes),
    token ? attempt(`views:${repo}`, () => getJson<any>(`${api}/repos/${repo}/traffic/views`, token), notes) : null,
    token ? attempt(`clones:${repo}`, () => getJson<any>(`${api}/repos/${repo}/traffic/clones`, token), notes) : null,
    token
      ? attempt(`referrers:${repo}`, () => getJson<any>(`${api}/repos/${repo}/traffic/popular/referrers`, token), notes)
      : null,
    token ? attempt(`paths:${repo}`, () => getJson<any>(`${api}/repos/${repo}/traffic/popular/paths`, token), notes) : null,
  ]);
  if (!meta) return null;
  return {
    repo,
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    watchers: meta.subscribers_count,
    openIssues: meta.open_issues_count ?? null,
    pushedAt: meta.pushed_at ?? null,
    traffic: {
      views14d: views ? { total: views.count, uniques: views.uniques, daily: views.views } : null,
      clones14d: clones ? { total: clones.count, uniques: clones.uniques, daily: clones.clones } : null,
      referrers: referrers ?? null,
      paths: paths
        ? paths.map((row: any) => ({ path: row.path, title: row.title, count: row.count, uniques: row.uniques }))
        : null,
    },
  };
}

function mergeTraffic(next: RepoTraffic, old: RepoTraffic | undefined): RepoTraffic {
  return {
    views14d: keep(next.views14d, old?.views14d),
    clones14d: keep(next.clones14d, old?.clones14d),
    referrers: keep(next.referrers, old?.referrers),
    paths: keep(next.paths, old?.paths),
  };
}

/** Write (merge) today's snapshot into `<dir>/<UTC-date>.json`. Returns the run notes. */
/**
 * Expand the watch list's HF entries into concrete model ids. An entry of the
 * form `Author/*` enumerates every model under that author AT READ TIME — the
 * fix for the list going stale: the two-id seed list sat blind to 18 published
 * cards (one id had even been renamed and answered 307) until someone noticed
 * the numbers "weren't following all my cards". Exact ids pass through, so a
 * card outside the account can still be watched by name.
 */
export async function expandHfModels(entries: string[], notes?: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of entries) {
    const wildcard = entry.match(/^([A-Za-z0-9_.-]+)\/\*$/u);
    if (!wildcard) {
      ids.push(entry);
      continue;
    }
    try {
      const models = await getJson<Array<{ id: string }>>(
        `https://huggingface.co/api/models?author=${wildcard[1]}&limit=500`,
        null,
      );
      ids.push(...models.map((m) => m.id));
    } catch (error) {
      notes?.push(`hf:${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(ids)].sort();
}

export async function writeExposureSnapshot(dir: string, portfolio: ExposurePortfolio): Promise<string[]> {
  const notes: string[] = [];
  const token = await githubToken();
  if (!token) notes.push('github: no token — traffic, referrers and clones skipped (public counters still recorded)');
  const hfIds = await expandHfModels(portfolio.hfModels, notes);

  const [repoRows, hf, crates] = await Promise.all([
    Promise.all(portfolio.repos.map((repo) => fetchRepo(repo, token, notes))),
    Promise.all(
      hfIds.map(async (id) => {
        const data = await attempt(`hf:${id}`, () => getJson<any>(`https://huggingface.co/api/models/${id}`, null), notes);
        return {
          id,
          // rolling 30-day figure for individual accounts — all we get below Enterprise
          downloads30d: data?.downloads ?? null,
          likes: data?.likes ?? null,
          lastModified: data?.lastModified ?? null,
        };
      }),
    ),
    Promise.all(
      portfolio.crates.map(async (name) => {
        const data = await attempt(`crate:${name}`, () => getJson<any>(`https://crates.io/api/v1/crates/${name}`, null), notes);
        return {
          name,
          totalDownloads: data?.crate?.downloads ?? null,
          recentDownloads: data?.crate?.recent_downloads ?? null,
          version: data?.crate?.max_version ?? null,
        };
      }),
    ),
  ]);

  const repos = repoRows.filter((r): r is RepoSnapshot => r !== null);
  const today = new Date().toISOString().slice(0, 10);
  const first = repos[0] ?? null;

  const snapshot: any = {
    takenAt: new Date().toISOString(),
    date: today,
    // legacy mirror of the first repo — older snapshots/readers use these fields
    repo: first ? { stars: first.stars, forks: first.forks, watchers: first.watchers, openIssues: first.openIssues, pushedAt: first.pushedAt } : null,
    traffic: first ? first.traffic : { views14d: null, clones14d: null, referrers: null, paths: null },
    repos,
    huggingface: hf,
    crates,
    notes,
  };

  await mkdir(dir, { recursive: true });
  const file = join(dir, `${today}.json`);

  // MERGE, never clobber: a run without a token must not reduce a snapshot that
  // already captured today's referrer table. Null fields yield to what the existing
  // file knows; both timestamps are kept so the assembly stays visible.
  const previous = await readFile(file, 'utf8').then(
    (text) => JSON.parse(text) as any,
    () => null,
  );
  if (previous) {
    snapshot.repo = keep(snapshot.repo, previous.repo);
    snapshot.traffic = mergeTraffic(snapshot.traffic, previous.traffic);
    const prevRepos: RepoSnapshot[] = Array.isArray(previous.repos) ? previous.repos : [];
    snapshot.repos = snapshot.repos.map((row: RepoSnapshot) => {
      const old = prevRepos.find((r) => r.repo === row.repo);
      return old ? { ...row, traffic: mergeTraffic(row.traffic, old.traffic) } : row;
    });
    snapshot.huggingface = snapshot.huggingface.map((row: any) => {
      const old = (previous.huggingface ?? []).find((m: any) => m.id === row.id);
      return { ...row, downloads30d: keep(row.downloads30d, old?.downloads30d), likes: keep(row.likes, old?.likes) };
    });
    snapshot.crates = snapshot.crates.map((row: any) => {
      const old = (previous.crates ?? []).find((c: any) => c.name === row.name);
      return {
        ...row,
        totalDownloads: keep(row.totalDownloads, old?.totalDownloads),
        recentDownloads: keep(row.recentDownloads, old?.recentDownloads),
      };
    });
    snapshot.takenAt = [previous.takenAt, snapshot.takenAt].filter(Boolean).join(' + ');
    // notes describe THIS run (a stale "no token" must not accuse a working credential
    // forever); what carried over from an earlier run today is named instead
    const carried = [
      snapshot.traffic.views14d && !first?.traffic.views14d ? 'views14d' : null,
      snapshot.traffic.referrers && !first?.traffic.referrers ? 'referrers' : null,
      snapshot.traffic.clones14d && !first?.traffic.clones14d ? 'clones14d' : null,
    ].filter(Boolean);
    if (carried.length) snapshot.notes = [...snapshot.notes, `carried from an earlier run today: ${carried.join(', ')}`];
  }

  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
  return notes;
}
