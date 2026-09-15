import type { ShippedCommit, ShippedPR, ShippedRepoTotal, ShippedReport } from '../../shared/types.js';

// Pure half of the shipped collector: day boundary, git/gh output parsing, and the
// fold into a report. No I/O here so the contract is unit-testable without a repo.

export const HOURS = 24;

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local day starts at `dayStartHour`, not midnight. A commit at 01:30 belongs to
 *  the evening it closed, so the board does not reset while you are mid-flow. */
export function dayStart(now: Date, dayStartHour: number): Date {
  const h = Number.isFinite(dayStartHour) ? Math.min(23, Math.max(0, Math.floor(dayStartHour))) : 0;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/** YYYY-MM-DD in the process's local zone; the shape `gh search` date filters take. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Record separator before each commit, unit separators between fields, so subjects
 *  with any punctuation parse. Pair with --shortstat for the +/- counts. */
export const LOG_FORMAT = '%x1e%H%x1f%cI%x1f%s';

/** Parse `git log --format=LOG_FORMAT --shortstat`. A commit with no textual change
 *  (rename-only, empty) prints a stat line without insertions or deletions, or none
 *  at all; both read as 0/0. */
export function parseGitLog(raw: string, repo: string, origin: string | null): ShippedCommit[] {
  const out: ShippedCommit[] = [];
  for (const chunk of raw.split('\x1e')) {
    const text = chunk.trim();
    if (!text) continue;
    const nl = text.indexOf('\n');
    const head = nl < 0 ? text : text.slice(0, nl);
    const stat = nl < 0 ? '' : text.slice(nl + 1);
    const [sha, at, subject = ''] = head.split('\x1f');
    if (!sha || !at) continue;
    out.push({
      sha,
      repo,
      origin,
      at,
      subject: subject.trim(),
      add: Number(stat.match(/(\d+) insertion/)?.[1] ?? 0),
      del: Number(stat.match(/(\d+) deletion/)?.[1] ?? 0),
    });
  }
  return out;
}

interface PrRow {
  number?: number;
  title?: string;
  url?: string;
  repository?: { nameWithOwner?: string; name?: string } | null;
  closedAt?: string | null;
  createdAt?: string | null;
}

/** "https://github.com/owner/name/pull/12" -> "owner/name" */
function repoFromUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return m ? m[1] : url;
}

/** Rows from `gh search prs --json ...`. Rows before `since` are dropped: the search
 *  API filters on calendar dates, the board on a local day start. Merged rows are
 *  stamped with closedAt (the merge time); open rows with createdAt. `total` is the
 *  row count before that trim, so a caller can tell a response that hit its --limit
 *  from one that merely had old rows in it. */
export function parsePrRows(
  raw: string,
  state: ShippedPR['state'],
  since: Date,
): { prs: ShippedPR[]; total: number } {
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return { prs: [], total: 0 };
  }
  if (!Array.isArray(rows)) return { prs: [], total: 0 };
  const out: ShippedPR[] = [];
  for (const r of rows as PrRow[]) {
    const at = state === 'merged' ? r.closedAt : r.createdAt;
    if (!at || typeof r.number !== 'number' || !r.url) continue;
    if (Date.parse(at) < since.getTime()) continue;
    out.push({
      repo: r.repository?.nameWithOwner ?? repoFromUrl(r.url),
      number: r.number,
      title: r.title ?? '',
      url: r.url,
      state,
      at,
    });
  }
  return { prs: out, total: rows.length };
}

const newestFirst = (a: { at: string }, b: { at: string }): number => Date.parse(b.at) - Date.parse(a.at);

export function buildReport(input: {
  since: Date;
  dayStartHour: number;
  authors: string[];
  commits: ShippedCommit[];
  prs: ShippedPR[];
  prsError: string | null;
  prsCapped?: boolean;
}): ShippedReport {
  // a repo cloned twice (or a worktree that slipped past the wt- filter) yields the
  // same sha from two paths; the first path in scan order keeps it
  const seen = new Set<string>();
  const commits = input.commits
    .filter((c) => (seen.has(c.sha) ? false : (seen.add(c.sha), true)))
    .sort(newestFirst);

  // a PR opened and merged today comes back from both searches; merged wins
  const byUrl = new Map<string, ShippedPR>();
  for (const p of input.prs) {
    const cur = byUrl.get(p.url);
    if (!cur || (cur.state === 'open' && p.state === 'merged')) byUrl.set(p.url, p);
  }
  const prs = [...byUrl.values()].sort(newestFirst);

  const sinceMs = input.since.getTime();
  const byHour: number[] = new Array(HOURS).fill(0);
  const repoMap = new Map<string, ShippedRepoTotal>();
  let add = 0;
  let del = 0;
  for (const c of commits) {
    const i = Math.floor((Date.parse(c.at) - sinceMs) / 3_600_000);
    if (i >= 0 && i < HOURS) byHour[i] += 1;
    const t = repoMap.get(c.repo) ?? { repo: c.repo, origin: c.origin, commits: 0, add: 0, del: 0 };
    t.commits += 1;
    t.add += c.add;
    t.del += c.del;
    repoMap.set(c.repo, t);
    add += c.add;
    del += c.del;
  }
  const byRepo = [...repoMap.values()].sort((a, b) => b.commits - a.commits || a.repo.localeCompare(b.repo));

  return {
    since: input.since.toISOString(),
    dayStartHour: input.dayStartHour,
    authors: input.authors,
    commits,
    prs,
    byHour,
    byRepo,
    totals: {
      commits: commits.length,
      repos: byRepo.length,
      add,
      del,
      prsMerged: prs.filter((p) => p.state === 'merged').length,
      prsOpened: prs.filter((p) => p.state === 'open').length,
    },
    prsError: input.prsError,
    prsCapped: input.prsCapped ?? false,
  };
}
