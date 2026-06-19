import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { RevutoReviewer, RevutoState } from '../../../shared/types.js';

type RevutoVaultState = Pick<RevutoState, 'counts' | 'schedules' | 'limits' | 'store' | 'reviewers'>;
type RevutoSchedules = NonNullable<RevutoState['schedules']>;
type RevutoLimits = NonNullable<RevutoState['limits']>;
type RevutoStoreInfo = NonNullable<RevutoState['store']>;

type Frontmatter = Record<string, string | boolean | string[] | Record<string, string>>;

async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function parseScalar(v: string): string | boolean | string[] | Record<string, string> {
  const s = v.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};
  return s.replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(markdown: string): Frontmatter {
  if (!markdown.startsWith('---\n')) return {};
  const end = markdown.indexOf('\n---', 4);
  if (end < 0) return {};
  const out: Frontmatter = {};
  const lines = markdown.slice(4, end).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const [, key, raw] = m;
    if (raw === '') {
      const nested: Record<string, string> = {};
      i++;
      while (i < lines.length) {
        const child = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!child) break;
        nested[child[1]] = String(parseScalar(child[2]));
        i++;
      }
      out[key] = nested;
      continue;
    }
    out[key] = parseScalar(raw);
    i++;
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function storeConfig(raw: any): RevutoStoreInfo {
  const store = raw?.store && typeof raw.store === 'object' ? raw.store : {};
  const surreal = store.surreal && typeof store.surreal === 'object' ? store.surreal : {};
  return {
    backend: str(store.backend || 'surreal'),
    url: typeof surreal.url === 'string' ? surreal.url : null,
    namespace: typeof surreal.namespace === 'string' ? surreal.namespace : null,
  };
}

function schedules(raw: any): RevutoSchedules {
  const s = raw?.schedules && typeof raw.schedules === 'object' ? raw.schedules : {};
  return { review: str(s.review), learn: str(s.learn), decay: str(s.decay) };
}

function limits(raw: any): RevutoLimits {
  const l = raw?.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const review = raw?.review && typeof raw.review === 'object' ? raw.review : {};
  return {
    maxSteps: num(review.maxSteps),
    dailyReviews: num(l.dailyReviews),
    dailyLearn: num(l.dailyLearn),
    dailyTokens: num(l.dailyTokens),
  };
}

export async function loadRevutoReviewers(vaultPath: string, defaultReviewSchedule = ''): Promise<RevutoReviewer[]> {
  const dir = join(vaultPath, 'reviewers');
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const reviewers: RevutoReviewer[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.md') || file === '_index.md') continue;
    const text = await readFile(join(dir, file), 'utf8').catch(() => '');
    const fm = parseFrontmatter(text);
    const repo = typeof fm.repo === 'string' ? fm.repo : '';
    if (!repo) continue;
    const schedules = fm.schedules && typeof fm.schedules === 'object' && !Array.isArray(fm.schedules) ? fm.schedules : {};
    reviewers.push({
      repo,
      paused: fm.paused === true,
      autoActivate: fm.autoActivate === true,
      reviewSchedule: typeof schedules.review === 'string' ? schedules.review : defaultReviewSchedule,
    });
  }
  return reviewers;
}


const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function reviewerNotePath(vaultPath: string, repo: string): string {
  if (!REPO_RE.test(repo)) throw new Error('repo must be owner/repo');
  const [owner, name] = repo.split('/');
  const base = resolve(vaultPath, 'reviewers');
  const path = resolve(base, `${owner}__${name}.md`);
  if (path !== base && !path.startsWith(base + sep)) throw new Error('reviewer path escapes vault');
  return path;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

function setFrontmatterField(markdown: string, key: string, value: string): string {
  if (!markdown.startsWith('---\n')) throw new Error('reviewer note has no frontmatter');
  const end = markdown.indexOf('\n---', 4);
  if (end < 0) throw new Error('reviewer note has no closing frontmatter marker');
  const fm = markdown.slice(4, end);
  const body = markdown.slice(end);
  const re = new RegExp(`^${key}:.*$`, 'm');
  const nextFm = re.test(fm) ? fm.replace(re, `${key}: ${value}`) : `${fm}\n${key}: ${value}`;
  return `---\n${nextFm.trimEnd()}${body}`;
}

export async function setRevutoPaused(vaultPath: string, repo: string, paused: boolean): Promise<boolean> {
  const path = reviewerNotePath(vaultPath, repo);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  await atomicWrite(path, setFrontmatterField(text, 'paused', paused ? 'true' : 'false'));
  return true;
}

/** Load Revuto's durable registry/config directly from the vault.
 *
 * The scheduler/review engine runs in-process; this only reads durable vault
 * config that survives Atrium restarts.
 */
export async function loadRevutoVaultState(vaultPath: string): Promise<RevutoVaultState> {
  const cfg = await readJson<any>(join(vaultPath, 'revuto.config.json'));
  const sched = schedules(cfg);
  const reviewers = await loadRevutoReviewers(vaultPath, sched.review);
  return {
    counts: {
      schedulerTasks: 0,
      dependenciesReady: 0,
      dependenciesTotal: 0,
      reviewers: reviewers.length,
      pausedReviewers: reviewers.filter((r) => r.paused).length,
      recentJobs: 0,
      recentFailures: 0,
      reviewed: 0,
      skipped: 0,
    },
    schedules: sched,
    limits: limits(cfg),
    store: storeConfig(cfg),
    reviewers,
  };
}
