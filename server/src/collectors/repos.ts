import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso, shTry } from '../util.js';
import type { Collector } from './registry.js';
import type { RepoInfo, ReposState } from '../../../shared/types.js';

// HARD RULE: facts only — never label a repo stale/abandoned here or downstream;
// git state says nothing about ship status (owner law).

// per-repo budget — the four git reads run in parallel, so wall time ≈ one timeout
const GIT_TIMEOUT_MS = 5_000;
const PARALLEL = 6;

function git(path: string, args: string[]): Promise<string | null> {
  return shTry('git', ['-C', path, ...args], { timeoutMs: GIT_TIMEOUT_MS });
}

async function readRepo(name: string, path: string): Promise<RepoInfo | null> {
  try {
    await stat(join(path, '.git')); // dir or file (worktree) both count
  } catch {
    return null;
  }
  const [status, head, counts, last] = await Promise.all([
    git(path, ['status', '--porcelain']),
    git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    // errors when no upstream is configured — tolerated, ahead/behind stay null
    git(path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    git(path, ['log', '-1', '--format=%cI']),
  ]);
  if (status === null) return null; // unreadable working tree — skip, never guess
  const ref = head?.trim() || null;
  const detached = ref === 'HEAD'; // rev-parse prints literal HEAD when detached
  // left = upstream-only commits (behind), right = local-only (ahead)
  const m = counts?.trim().match(/^(\d+)\s+(\d+)$/) ?? null;
  return {
    name,
    path,
    branch: detached ? null : ref,
    detached,
    dirty: status.split('\n').filter((l) => l.trim() !== '').length,
    ahead: m ? Number(m[2]) : null,
    behind: m ? Number(m[1]) : null,
    lastCommitAt: last?.trim() || null,
  };
}

/** Run fn over items with at most `limit` in flight. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// last-good: a transient failure keeps the previous list with its real updatedAt;
// updatedAt stays null until the first success so never-collected can't read as fresh
let lastGood: ReposState | null = null;

const collector: Collector = {
  name: 'repos',
  intervalMs: config.poll.reposMs,
  async run() {
    let state: ReposState;
    try {
      const root = config.paths.projectsDir;
      const entries = await readdir(root, { withFileTypes: true });
      // one level deep; symlinked project dirs count, dotdirs don't
      const dirs = entries
        .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
        .map((e) => ({ name: e.name, path: join(root, e.name) }));
      const repos = (await mapPool(dirs, PARALLEL, (d) => readRepo(d.name, d.path))).filter(
        (r): r is RepoInfo => r !== null,
      );
      repos.sort((a, b) => b.dirty - a.dirty || a.name.localeCompare(b.name));
      state = { updatedAt: iso(), repos, error: null };
      lastGood = state;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state = lastGood ? { ...lastGood, error: msg } : { updatedAt: null, repos: [], error: msg };
    }
    store.setSection('repos', state);
  },
};

export default collector;
