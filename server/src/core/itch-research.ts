/**
 * itch research lifecycle, fully native to Atrium: builds the prompt with
 * itch-engine, samples collision domains when collide is on, runs the model via
 * `eigen` directly (the model harness, allowed), STREAMS progress into a live
 * log, saves the run with faithful metadata (compare_key/baseline_for), and
 * enforces a hard cap + idle watchdog. No external app is spawned.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { iso } from '../util.js';
import {
  buildResearchRunMeta,
  buildUserPrompt,
  composeSystemPrompt,
  defaultOwners,
  loadWorkPatterns,
  sampleCollisionDomains,
  saveRun,
  DEFAULT_PROJECTS_DIR,
} from './itch-engine.js';
import { loadItchModels } from './itch.js';

const MAX_LOG_LINES = 1000;
const ORBIT_MAX_CHARS = 4000;
// Hard cap + idle watchdog (parity with the Python research() watchdog).
const HARD_CAP_MS = Number(process.env.ITCH_RESEARCH_TIMEOUT_MS || 30 * 60_000);
const QUIET_AFTER_MS = Number(process.env.ITCH_RESEARCH_QUIET_MS || 10 * 60_000);

type LineFn = (line: string) => void;

interface RunHandle {
  model: string;
  promptFile: string;
  args: string[];
  meta: Record<string, unknown>;
}

interface State {
  proc: ChildProcess | null;
  pid: number | null;
  started: string | null;
  log: string[];
  logOffset: number;
  partial: string;
  exitCode: number | null;
  savedStem: string | null;
  killedReason: string | null;
  lastActivity: number;
}

const state: State = {
  proc: null, pid: null, started: null, log: [], logOffset: 0, partial: '',
  exitCode: null, savedStem: null, killedReason: null, lastActivity: 0,
};

let starting = false;

function trimLog(): void {
  if (state.log.length <= MAX_LOG_LINES) return;
  const drop = state.log.length - MAX_LOG_LINES;
  state.log.splice(0, drop);
  state.logOffset += drop;
}

function append(text: string): void {
  if (!text) return;
  state.lastActivity = Date.now();
  state.partial += text;
  if (!state.partial.includes('\n')) return;
  const parts = state.partial.split('\n');
  state.partial = parts.pop() ?? '';
  state.log.push(...parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)));
  trimLog();
}

function running(): boolean {
  return !!state.proc && state.exitCode === null && state.proc.exitCode === null && !state.proc.killed;
}

async function resolveModel(modelFromFlag?: string): Promise<string> {
  if (modelFromFlag && modelFromFlag.trim()) return modelFromFlag.trim();
  return (await loadItchModels(config.paths)).selected;
}

function eigenArgsFor(model: string, promptFile: string): string[] {
  const args = ['-p', '-perm', 'auto', '-prompt-file', promptFile];
  if (model.startsWith('eigen:')) {
    const rest = model.slice('eigen:'.length);
    const i = rest.indexOf('/');
    if (i >= 0) { args.push('-provider', rest.slice(0, i), '-model', rest.slice(i + 1)); } else args.push('-model', rest);
  } else if (model.startsWith('pi:')) {
    const rest = model.slice('pi:'.length);
    const i = rest.indexOf('/');
    args.push('-provider', 'llama', '-model', i >= 0 ? rest.slice(i + 1) : rest);
  } else {
    args.push('-provider', 'converse', '-model', model);
  }
  return args;
}

async function buildHandle(flags: Record<string, unknown>): Promise<RunHandle> {
  const model = await resolveModel(typeof flags.model === 'string' ? flags.model : undefined);
  const collisionTemp = typeof flags.collision_temp === 'number' && Number.isFinite(flags.collision_temp)
    ? Math.max(0, Math.min(1, flags.collision_temp))
    : null;
  const collideOn = collisionTemp !== null && collisionTemp > 0;
  const orbit = typeof flags.orbit === 'string' ? flags.orbit.slice(0, ORBIT_MAX_CHARS) : '';
  // collide (scatter) and orbit (focus) are mutually exclusive (parity w/ CLI).
  if (collideOn && orbit.trim()) throw new Error('collide and orbit are mutually exclusive');

  // Sample real collision domains (graceful [] on failure -> exact baseline).
  let sampledDomains: string[] = [];
  if (collideOn) {
    append(`[collide] sampling real domains at temperature ${collisionTemp}…\n`);
    sampledDomains = await sampleCollisionDomains(collisionTemp);
    if (sampledDomains.length) append(`[collide] sampled: ${sampledDomains.join(', ')}\n`);
    else append('[collide] no domains sampled — degrading to baseline run\n');
  }
  const collideActive = collideOn && sampledDomains.length > 0;

  const system = composeSystemPrompt({
    market: !!flags.market,
    collide: collideActive,
    orbit: !!orbit.trim(),
  });
  const owners = Array.isArray(flags.owners) && flags.owners.length ? flags.owners.map(String) : await defaultOwners();
  const flagWork = Array.isArray(flags.work) ? flags.work.map(String) : [];
  const work = [...new Set([...flagWork, ...(await loadWorkPatterns())])];
  const user = await buildUserPrompt({
    market: !!flags.market,
    collisionSeeds: collideActive ? sampledDomains : undefined,
    orbit: orbit.trim() ? orbit : undefined,
    useGh: !flags.no_gh,
    useLocal: !flags.no_local,
    noHistory: !!flags.no_history,
    historyBeforeStem: typeof flags.history_before === 'string' ? flags.history_before : null,
    owners,
    work,
    projectsDir: typeof flags.projects_dir === 'string' ? flags.projects_dir : undefined,
  });

  const meta = buildResearchRunMeta({
    model,
    flags: {
      no_gh: !!flags.no_gh, no_local: !!flags.no_local, no_history: !!flags.no_history,
      fresh: !!flags.fresh, market: !!flags.market,
    },
    collisionTemp,
    orbit: orbit.trim() || null,
    collisionSeeded: collideActive,
    sampledDomains,
    owners,
    projectsDir: typeof flags.projects_dir === 'string' ? flags.projects_dir : DEFAULT_PROJECTS_DIR,
    work,
    historyBefore: typeof flags.history_before === 'string' ? flags.history_before : null,
    baselineFor: typeof flags.baseline_for === 'string' ? flags.baseline_for : null,
  });

  const dir = await mkdtemp(join(tmpdir(), 'atrium-itch-'));
  const promptFile = join(dir, 'prompt.md');
  await writeFile(promptFile, `${system}\n\n---\n\n${user}\n`, 'utf8');
  return { model, promptFile, args: eigenArgsFor(model, promptFile), meta };
}

function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try { process.kill(-proc.pid, signal); } // negative pid = whole process group
  catch { try { proc.kill(signal); } catch { /* ignore */ } }
}

/** Spawn eigen with streamed stdout/stderr and a watchdog. Resolves with the
 * full stdout (the saved run text) and exit code. */
function runEigen(handle: RunHandle, onStderr: LineFn): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('eigen', handle.args, {
      env: process.env,
      cwd: handle.promptFile.replace(/\/[^/]+$/, ''), // sandbox writes to the temp dir
      detached: true,           // own process group so we can kill children too
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.proc = child;
    state.pid = child.pid ?? null;
    state.lastActivity = Date.now();
    const start = Date.now();
    const stdoutChunks: string[] = [];
    let stderrBuf = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { state.lastActivity = Date.now(); stdoutChunks.push(d); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      state.lastActivity = Date.now();
      stderrBuf += d;
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) onStderr(line);
      }
    });

    const watchdog = setInterval(() => {
      if (child.exitCode !== null) return;
      const now = Date.now();
      if (HARD_CAP_MS && now - start > HARD_CAP_MS) {
        state.killedReason = `hard cap ${Math.round(HARD_CAP_MS / 1000)}s exceeded`;
        killGroup(child, 'SIGTERM');
      } else if (QUIET_AFTER_MS && now - state.lastActivity > QUIET_AFTER_MS) {
        state.killedReason = `silent for >${Math.round(QUIET_AFTER_MS / 1000)}s`;
        killGroup(child, 'SIGTERM');
      }
    }, 2000);
    watchdog.unref?.();

    child.on('error', (err) => {
      onStderr(`[spawn error] ${err instanceof Error ? err.message : String(err)}`);
      clearInterval(watchdog);
      resolve({ code: 1, stdout: stdoutChunks.join('') });
    });
    child.on('close', (code) => {
      clearInterval(watchdog);
      if (stderrBuf.trim()) onStderr(stderrBuf);
      resolve({ code: typeof code === 'number' ? code : 0, stdout: stdoutChunks.join('') });
    });
  });
}

export interface StartResearchResult {
  ok: boolean;
  pid?: number;
  started?: string | null;
  error?: string;
}

export async function startItchResearch(flags: Record<string, unknown> = {}): Promise<StartResearchResult> {
  if (starting || running()) return { ok: false, error: 'research already running' };
  starting = true;
  // Reset state up front so status reflects the new run immediately.
  state.log = [];
  state.logOffset = 0;
  state.partial = '';
  state.exitCode = null;
  state.savedStem = null;
  state.killedReason = null;
  state.started = iso();
  state.lastActivity = Date.now();
  try {
    const handle = await buildHandle(flags);
    state.log.push(`$ eigen ${handle.args.join(' ')}  (model=${handle.model})`);
    void (async () => {
      try {
        const { code, stdout } = await runEigen(handle, (line) => append(`${line}\n`));
        if (state.partial) { state.log.push(state.partial); state.partial = ''; trimLog(); }
        const text = stdout.trim();
        let savedStem: string | null = null;
        if (text && !state.killedReason) {
          try {
            savedStem = await saveRun(text, handle.meta);
          } catch (err) {
            append(`[save failed] ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
        state.exitCode = code;
        state.savedStem = savedStem;
      } finally {
        state.proc = null;
        state.pid = null;
        try { await unlink(handle.promptFile); } catch { /* tmp */ }
      }
    })();
    return { ok: true, pid: state.pid ?? undefined, started: state.started };
  } catch (err) {
    state.exitCode = 1;
    append(`[start failed] ${err instanceof Error ? err.message : String(err)}\n`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    starting = false;
  }
}

export function stopItchResearch(): { ok: boolean } {
  if (!running() || !state.proc) return { ok: true };
  state.killedReason = state.killedReason || 'stopped via Atrium';
  killGroup(state.proc, 'SIGTERM');
  return { ok: true };
}

export function itchResearchStatus(since?: number): Record<string, unknown> {
  const lineBase = state.logOffset;
  const requested = typeof since === 'number' && Number.isFinite(since) ? Math.max(0, Math.floor(since)) : lineBase;
  const start = Math.max(0, requested - lineBase);
  const truncated = requested < lineBase;
  return {
    running: running(),
    started: state.started,
    log: state.log.slice(start),
    log_offset: Math.max(requested, lineBase),
    log_truncated: truncated,
    partial: state.partial,
    lines: state.logOffset + state.log.length,
    exit_code: state.exitCode,
    saved_stem: state.savedStem,
    killed_reason: state.killedReason,
  };
}
