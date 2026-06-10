// "send to eigen" — hand a task (usually a github item) to the eigen agent.
// Prefers the eigen daemon socket; falls back to a detached headless run whose
// output lands in ~/.config/atrium/eigen-runs/<id>.log. Runs are persisted to
// runs.json so the agents collector can render them across restarts.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { EigenDispatch } from '../../shared/types.js';
import { config } from './config.js';
import { iso, readJson } from './util.js';

const EIGEN_BIN = join(homedir(), '.local', 'bin', 'eigen');
const RUNS_DIR = join(config.configDir, 'eigen-runs');
const RUNS_FILE = join(RUNS_DIR, 'runs.json');
const MAX_RUNS = 50;
const DAEMON_TIMEOUT_MS = 1000;
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
      mode: (await daemonSockExists()) ? 'daemon' : 'headless',
      status: 'done',
      startedAt: now,
      endedAt: now,
      logPath: null,
      sourceId: req.sourceId,
    };
  }

  const id = randomUUID();
  const startedAt = iso();

  const sessionId = await tryDaemon(dir, prompt);
  if (sessionId) {
    const d: StoredDispatch = {
      id,
      title: req.title,
      prompt,
      dir,
      mode: 'daemon',
      status: 'running',
      startedAt,
      endedAt: null,
      logPath: null,
      sourceId: req.sourceId,
      sessionId,
    };
    await record(d);
    return publicView(d);
  }

  // headless fallback: detached eigen -p, output to a per-run log
  await mkdir(RUNS_DIR, { recursive: true });
  const logPath = join(RUNS_DIR, `${id}.log`);
  const log = await open(logPath, 'w');
  let child: ChildProcess;
  try {
    child = spawn(EIGEN_BIN, ['-p', prompt], {
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

// ---------- daemon ----------

async function daemonSockExists(): Promise<boolean> {
  try {
    await stat(config.paths.eigenDaemonSock);
    return true;
  } catch {
    return false;
  }
}

/** {"op":"new","dir"} → session id, then {"op":"input","id","text"}. Null on any failure within 1s. */
function tryDaemon(dir: string, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createConnection(config.paths.eigenDaemonSock);
    let settled = false;
    let inputSent = false;
    let buf = '';
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), DAEMON_TIMEOUT_MS);
    timer.unref();
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ op: 'new', dir })}\n`);
    });
    sock.on('data', (d) => {
      if (settled || inputSent) return;
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let resp: any;
      try {
        resp = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(null);
      }
      const sid = sessionIdFrom(resp);
      if (!sid) return finish(null);
      inputSent = true;
      sock.write(`${JSON.stringify({ op: 'input', id: sid, text: prompt })}\n`, (err) => finish(err ? null : sid));
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

function sessionIdFrom(resp: any): string | null {
  for (const v of [resp?.id, resp?.session_id, resp?.sessionId, resp?.session?.id]) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
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
    if (pidAlive(d.pid)) continue; // headless child survived the restart; exit will go unobserved though
    d.status = 'error'; // orphaned by restart — daemon runs lose their observer, dead pids are gone
    d.endedAt = iso();
    changed = true;
  }
  if (changed) await persist();
}

await loadRuns().catch(() => {});
