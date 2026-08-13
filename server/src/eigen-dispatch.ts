// "open in grok" — hand a task (usually a github item) to a detached grok
// headless run. Output lands in ~/.config/atrium/eigen-runs/<id>.log (legacy
// dir name; the record is the same dispatch log the agents panel renders).
// Runs persist in runs.json so they survive atrium restarts.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { EigenDispatch } from '../../shared/types.js';
import { config } from './config.js';
import { iso, readJson, tailLines } from './util.js';

const GROK_BIN = config.paths.grokBin;
const RUNS_DIR = join(config.configDir, 'eigen-runs');
const RUNS_FILE = join(RUNS_DIR, 'runs.json');
const MAX_RUNS = 50;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** On-disk superset of EigenDispatch — pid/sessionId stay in runs.json, never in the snapshot. */
interface StoredDispatch extends EigenDispatch {
  pid?: number;
  sessionId?: string;
}

let runs: StoredDispatch[] = []; // newest first

interface DispatchRequest {
  title: string;
  prompt: string | null;
  repo: string | null;
  url: string | null;
  sourceId: string | null;
  dry: boolean;
}

function optStr(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
}

function validate(body: any): DispatchRequest {
  const title = body?.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 300) {
    throw new Error('title required: non-empty string of at most 300 chars');
  }
  const repo = optStr(body?.repo, 'repo');
  if (repo !== null && !REPO_RE.test(repo)) throw new Error('repo must look like "owner/name"');
  const url = optStr(body?.url, 'url');
  if (url !== null && !url.startsWith('https://github.com/')) {
    throw new Error('url must start with https://github.com/');
  }
  const sourceId = optStr(body?.sourceId, 'sourceId');
  if (sourceId !== null && sourceId.length > 100) throw new Error('sourceId must be at most 100 chars');
  const prompt = optStr(body?.prompt, 'prompt');
  if (prompt !== null && prompt.length > 4000) throw new Error('prompt must be at most 4000 chars');
  return { title, prompt: prompt?.trim() ? prompt : null, repo, url, sourceId, dry: body?.dry === true };
}

/** repo given → ~/projects/<basename> when it exists and is a git checkout; else $HOME. */
async function resolveDir(repo: string | null): Promise<string> {
  if (repo) {
    const name = basename(repo);
    if (name && name !== '.' && name !== '..') {
      const candidate = join(homedir(), 'projects', name);
      try {
        await stat(join(candidate, '.git'));
        return candidate;
      } catch {
        /* not a checkout here — run from home */
      }
    }
  }
  return homedir();
}

function composePrompt(title: string, url: string | null): string {
  return (
    `Take care of this GitHub task: "${title}"` +
    (url ? ` — ${url}` : '') +
    '. Investigate and handle it: answer/triage if it is a question, implement on a branch if code is needed, and summarize what you did.'
  );
}

function publicView(d: StoredDispatch): EigenDispatch {
  // explicit field list — internal extras (pid, sessionId) must not leak into the snapshot
  return {
    id: d.id,
    title: d.title,
    prompt: d.prompt,
    dir: d.dir,
    mode: d.mode,
    status: d.status,
    startedAt: d.startedAt,
    endedAt: d.endedAt,
    logPath: d.logPath,
    sourceId: d.sourceId,
  };
}

export function getDispatches(): EigenDispatch[] {
  return runs.map(publicView);
}

// daemon-mode runs have no child to observe exit on — the agents collector hands
// us the daemon session list each cycle and we settle open runs against it.
const RECONCILE_GRACE_MS = 20_000;
// daemon sessions are in-proc, so a confirmed-down daemon means every session in it is
// dead. loadRuns deliberately skips daemon-mode runs, so this is the ONLY close path —
// without it a dispatch outlives a dead daemon as 'running' forever.
const DAEMON_DOWN_CYCLES = 3; // ~30s at the 10s agents poll — rides out one-off sock blips
let daemonNullCycles = 0;

/** null = daemon unreachable this cycle: a blip leaves runs open, but after
 *  DAEMON_DOWN_CYCLES consecutive misses open daemon runs close as 'error'. */
export function reconcileEigenDispatches(sessions: Array<{ id?: unknown; status?: unknown }> | null): void {
  const now = Date.now();
  if (!sessions) {
    daemonNullCycles += 1;
    if (daemonNullCycles < DAEMON_DOWN_CYCLES) return;
    for (const d of runs) {
      if (d.status !== 'running' || d.mode !== 'daemon' || !d.sessionId) continue;
      if (now - Date.parse(d.startedAt) < RECONCILE_GRACE_MS) continue;
      closeRun(d.id, 'error'); // daemon confirmed down — the in-proc session died with it
    }
    return;
  }
  daemonNullCycles = 0;
  for (const d of runs) {
    if (d.status !== 'running' || d.mode !== 'daemon' || !d.sessionId) continue;
    // grace: a just-dispatched session can report idle before its input is picked up
    if (now - Date.parse(d.startedAt) < RECONCILE_GRACE_MS) continue;
    const s = sessions.find((x) => String(x?.id ?? '') === d.sessionId);
    if (!s) closeRun(d.id, 'error'); // evicted from daemon — completion never observed
    else if (s.status === 'error') closeRun(d.id, 'error');
    else if (s.status === 'idle') closeRun(d.id, 'done'); // working/approval = still going
  }
}

// uuid charset only — rejects path tricks before the id touches any lookup
const DISPATCH_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

/** GET /api/eigen/dispatch/:id/log handler — null means unknown id (404). */
export async function getDispatchLog(id: string): Promise<{ log: string } | null> {
  if (!DISPATCH_ID_RE.test(id)) return null;
  const d = runs.find((r) => r.id === id);
  if (!d) return null;
  if (!d.logPath) return { log: '' }; // daemon-mode runs write no headless log
  const lines = await tailLines(d.logPath, 200);
  return { log: lines.join('\n') };
}

export async function dispatchToEigen(body: any): Promise<EigenDispatch> {
  const req = validate(body);
  const dir = await resolveDir(req.repo);
  const prompt = req.prompt ?? composePrompt(req.title, req.url);

  if (req.dry) {
    const now = iso();
    return {
      id: 'dry',
      title: req.title,
      prompt,
      dir,
      mode: 'headless',
      status: 'done',
      startedAt: now,
      endedAt: now,
      logPath: null,
      sourceId: req.sourceId,
    };
  }

  const id = randomUUID();
  const startedAt = iso();

  // detached grok -p: unattended headless run, never attach to the user's TUI
  await mkdir(RUNS_DIR, { recursive: true });
  const logPath = join(RUNS_DIR, `${id}.log`);
  // 0600: captures an autonomous agent's full output while it holds the user's credentials
  const log = await open(logPath, 'w', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(GROK_BIN, ['-p', prompt, '--always-approve'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
  } catch (err) {
    await log.close().catch(() => {});
    throw err;
  }
  child.unref();
  await log.close().catch(() => {}); // child holds its own copies of the fd

  const d: StoredDispatch = {
    id,
    title: req.title,
    prompt,
    dir,
    mode: 'headless',
    status: 'running',
    startedAt,
    endedAt: null,
    logPath,
    sourceId: req.sourceId,
    pid: child.pid,
  };
  child.on('exit', (code) => closeRun(id, code === 0 ? 'done' : 'error'));
  child.on('error', () => closeRun(id, 'error')); // spawn failure (e.g. binary missing)
  await record(d);
  return publicView(d);
}

// ---------- persistence ----------

async function record(d: StoredDispatch): Promise<void> {
  runs.unshift(d);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  await persist(); // best-effort — never fails the dispatch
}

function closeRun(id: string, status: 'done' | 'error'): void {
  const d = runs.find((r) => r.id === id);
  if (!d || d.status !== 'running') return;
  d.status = status;
  d.endedAt = iso();
  void persist();
}

let persisting: Promise<void> = Promise.resolve();

/** Serialized atomic write of runs.json; swallows fs errors (runs stay in memory). */
function persist(): Promise<void> {
  persisting = persisting
    .then(async () => {
      await mkdir(RUNS_DIR, { recursive: true });
      const tmp = `${RUNS_FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(runs, null, 2), 'utf8');
      await rename(tmp, RUNS_FILE);
    })
    .catch(() => {
      /* persistence is best-effort */
    });
  return persisting;
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Load persisted runs; close out 'running' entries orphaned by a server restart. */
async function loadRuns(): Promise<void> {
  const data = await readJson<StoredDispatch[]>(RUNS_FILE);
  if (!Array.isArray(data)) return;
  runs = data.filter((d): d is StoredDispatch => Boolean(d) && typeof d?.id === 'string').slice(0, MAX_RUNS);
  let changed = false;
  for (const d of runs) {
    if (d.status !== 'running') continue;
    if (d.mode === 'daemon' && d.sessionId) continue; // settled by reconcileEigenDispatches next agents cycle
    if (pidAlive(d.pid)) continue; // headless child survived the restart; exit will go unobserved though
    d.status = 'error'; // orphaned by restart — dead pids are gone
    d.endedAt = iso();
    changed = true;
  }
  if (changed) await persist();
}

await loadRuns().catch(() => {});
