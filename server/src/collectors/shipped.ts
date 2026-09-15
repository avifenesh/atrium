import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso, sh, shTry } from '../util.js';
import { listRepoDirs, mapPool, parseOrigin } from './repos.js';
import type { Collector } from './registry.js';
import { LOG_FORMAT, buildReport, dayStart, localDate, parseGitLog, parsePrRows } from '../shipped.js';
import type { ExtraRow, ShippedCommit, ShippedPR, ShippedReport } from '../../../shared/types.js';

// The day's receipt: what you actually shipped since the local day start. One git log
// per repo under projectsDir (the same set the repos collector walks) plus two gh
// searches for the PRs you merged and opened. Read-only, no flags: nothing here needs
// attention, it is the thing you look at before closing the lid. Live repo state
// (dirty trees, ahead/behind) stays with the repos collector.
//
// Ref selection is deliberate: --branches --remotes sees commits made in any worktree
// of the repo (they share refs) and commits pushed from another machine, while leaving
// out refs/stash (WIP snapshots are not shipping) and tags. --no-merges drops "Merge
// pull request" commits; squash merges are ordinary commits and stay.

const TITLE = 'shipped today';
const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 20_000;
const PARALLEL = 6;
// gh accepts up to 1000; 200 covers a very busy day and a hit on the cap is reported
const PR_LIMIT = 200;
const PR_FIELDS = 'number,title,url,repository,closedAt,createdAt';

/** config.shipped.authors, else the identity git itself would stamp on a commit. */
async function resolveAuthors(): Promise<string[]> {
  if (config.shipped.authors.length > 0) return config.shipped.authors;
  const [email, name] = await Promise.all([
    shTry('git', ['config', '--get', 'user.email']),
    shTry('git', ['config', '--get', 'user.name']),
  ]);
  return [email, name].map((s) => s?.trim() ?? '').filter(Boolean);
}

async function repoCommits(
  dir: { name: string; path: string },
  since: Date,
  authors: string[],
): Promise<ShippedCommit[]> {
  // a plain directory inside a git-tracked parent would otherwise report the parent's log
  try {
    await stat(join(dir.path, '.git'));
  } catch {
    return [];
  }
  const raw = await shTry(
    'git',
    [
      // --fixed-strings: the author patterns are an email and a name, not regexes; a
      // '[' or '*' in either would otherwise fail the log and read as a zero-commit day
      '-C', dir.path, 'log', '--fixed-strings', '--branches', '--remotes', '--no-merges',
      `--since=${since.toISOString()}`, `--format=${LOG_FORMAT}`, '--shortstat',
      ...authors.map((a) => `--author=${a}`),
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (!raw?.trim()) return []; // unreadable, or nothing landed today
  const origin = parseOrigin(await shTry('git', ['-C', dir.path, 'remote', 'get-url', 'origin']));
  return parseGitLog(raw, dir.name, origin);
}

/** Two searches per poll, well inside the search API's budget at this cadence.
 *  Newest first so the row cap drops the oldest of a very busy day, not the latest. One
 *  day of slack on the date filter: it works on calendar dates, the board on a local
 *  day start, and parsePrRows trims the rest. */
async function githubPrs(since: Date): Promise<{ prs: ShippedPR[]; error: string | null; capped: boolean }> {
  const from = localDate(new Date(since.getTime() - 86_400_000));
  try {
    const [merged, opened] = await Promise.all([
      sh('gh', ['search', 'prs', '--author=@me', '--merged', `--merged-at=>=${from}`, '--sort', 'updated', '--order', 'desc', '--limit', String(PR_LIMIT), '--json', PR_FIELDS], { timeoutMs: GH_TIMEOUT_MS }),
      sh('gh', ['search', 'prs', '--author=@me', `--created=>=${from}`, '--sort', 'created', '--order', 'desc', '--limit', String(PR_LIMIT), '--json', PR_FIELDS], { timeoutMs: GH_TIMEOUT_MS }),
    ]);
    const mergedRows = parsePrRows(merged, 'merged', since);
    const openedRows = parsePrRows(opened, 'open', since);
    return { prs: [...mergedRows, ...openedRows], error: null, capped: mergedRows.length >= PR_LIMIT || openedRows.length >= PR_LIMIT };
  } catch (err) {
    return { prs: [], error: err instanceof Error ? err.message : String(err), capped: false };
  }
}

/** Generic-panel and MCP surface; the panel reads `data` for the rest. */
function rows(r: ShippedReport): ExtraRow[] {
  const t = r.totals;
  const since = new Date(r.since);
  const out: ExtraRow[] = [
    {
      label: 'commits',
      value: t.commits ? `${t.commits} in ${t.repos} repo${t.repos === 1 ? '' : 's'}` : 'none yet',
      tone: t.commits ? 'ok' : undefined,
    },
    { label: 'lines', value: `+${t.add} / -${t.del}` },
    { label: 'prs merged', value: `${t.prsMerged}${r.prsCapped ? '+' : ''}`, tone: t.prsMerged ? 'ok' : undefined },
    { label: 'prs opened', value: `${t.prsOpened}${r.prsCapped ? '+' : ''}` },
    { label: 'since', value: `${localDate(since)} ${String(since.getHours()).padStart(2, '0')}:00` },
  ];
  if (r.prsError) out.push({ label: 'github', value: r.prsError.slice(0, 160), tone: 'err' });
  return out;
}

// last-good: a failed cycle keeps the previous report on screen with its real updatedAt
let lastGood: { report: ShippedReport; at: string } | null = null;

const collector: Collector = {
  name: 'shipped',
  intervalMs: config.poll.shippedMs,
  async run() {
    const since = dayStart(new Date(), config.shipped.dayStartHour);
    try {
      const authors = await resolveAuthors();
      if (authors.length === 0) throw new Error('no git identity: set shipped.authors or git config user.email');
      // wt-* dirs are worktrees; their commits are already visible from the parent's refs
      const dirs = (await listRepoDirs())
        .filter((d) => !(d.name.split('/').at(-1) ?? d.name).startsWith('wt-'))
        .sort((a, b) => a.name.localeCompare(b.name));
      const [perRepo, gh] = await Promise.all([
        mapPool(dirs, PARALLEL, (d) => repoCommits(d, since, authors)),
        githubPrs(since),
      ]);
      const report = buildReport({
        since,
        dayStartHour: config.shipped.dayStartHour,
        authors,
        commits: perRepo.flat(),
        prs: gh.prs,
        prsError: gh.error,
        prsCapped: gh.capped,
      });
      lastGood = { report, at: iso() };
      store.setExtra('shipped', { title: TITLE, updatedAt: lastGood.at, up: true, error: null, rows: rows(report), data: report });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.setExtra('shipped', {
        title: TITLE,
        updatedAt: lastGood?.at ?? null,
        up: false,
        error: msg,
        rows: lastGood ? rows(lastGood.report) : [],
        data: lastGood?.report,
      });
    }
  },
};

export default collector;
