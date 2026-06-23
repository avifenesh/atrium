/**
 * itch research lifecycle, fully native to Atrium: builds the prompt with
 * itch-engine, samples collision domains when collide is on, runs the model via
 * `eigen` directly (the model harness, allowed), STREAMS progress into a live
 * log, saves the run with faithful metadata (compare_key/baseline_for), and
 * enforces a hard cap + idle watchdog. No external app is spawned.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, unlink, readFile, mkdir } from 'node:fs/promises';
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

// In-flight checkpoint: a long pass can be killed (OOM, server restart, the
// watchdog) AFTER the model produced partial ideas but BEFORE the run is saved,
// losing all that work. We stream the prompt + partial answer to disk so an
// interrupted run can be RESUMED instead of re-run. Lives in the itch config
// dir, NOT itchRuns, so the run globs never see it. Cleared on a clean save.
const INFLIGHT_JSON = join(config.paths.itchConfig, 'research-inflight.json');
const INFLIGHT_MD = join(config.paths.itchConfig, 'research-inflight.md');
const INFLIGHT_FLUSH_MS = 8_000; // bound checkpoint IO; at most this stale
const RESUME_PARTIAL_MAX_CHARS = 12_000;

interface InflightCtx {
  system: string;
  user: string;
  model: string;
  meta: Record<string, unknown>;
}

type LineFn = (line: string) => void;

interface RunHandle {
  model: string;
  promptFile: string;
  args: string[];
  meta: Record<string, unknown>;
  system: string;
  user: string;
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
  /** a checkpoint from a mid-flight kill exists on disk -> resume is offered */
  resumable: boolean;
}

const state: State = {
  proc: null, pid: null, started: null, log: [], logOffset: 0, partial: '',
  exitCode: null, savedStem: null, killedReason: null, lastActivity: 0,
  resumable: false,
};

let starting = false;

// On boot, reflect any checkpoint left by a server that died mid-run (so the
// UI offers resume even across a restart). Best-effort, fire-and-forget.
void loadInflight().then((ctx) => { if (ctx) state.resumable = true; }).catch(() => {});

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
  return { model, promptFile, args: eigenArgsFor(model, promptFile), meta, system, user };
}

// --- in-flight checkpoint / resume -----------------------------------------

async function inflightBegin(handle: RunHandle): Promise<void> {
  try {
    await mkdir(config.paths.itchConfig, { recursive: true });
    const ctx: InflightCtx = { system: handle.system, user: handle.user, model: handle.model, meta: handle.meta };
    await writeFile(INFLIGHT_JSON, JSON.stringify({ schema: 1, ...ctx, started_at: iso() }, null, 2), 'utf8');
    await writeFile(INFLIGHT_MD, '', 'utf8');
  } catch { /* checkpoint IO must never block the run */ }
}

async function inflightFlush(text: string): Promise<void> {
  try { await writeFile(INFLIGHT_MD, text, 'utf8'); } catch { /* best-effort */ }
}

async function inflightClear(): Promise<void> {
  await Promise.all([
    unlink(INFLIGHT_JSON).catch(() => {}),
    unlink(INFLIGHT_MD).catch(() => {}),
  ]);
}

/** The saved checkpoint, or null if there's nothing resumable (no context, or a
 * partial that's empty -> the run died before the model wrote anything). */
export async function loadInflight(): Promise<(InflightCtx & { partial: string }) | null> {
  let ctx: any;
  try { ctx = JSON.parse(await readFile(INFLIGHT_JSON, 'utf8')); } catch { return null; }
  if (!ctx || typeof ctx.system !== 'string' || typeof ctx.user !== 'string' || !ctx.system || !ctx.user) return null;
  let partial = '';
  try { partial = await readFile(INFLIGHT_MD, 'utf8'); } catch { partial = ''; }
  if (!partial.trim()) return null;
  return { system: ctx.system, user: ctx.user, model: String(ctx.model ?? ''), meta: ctx.meta ?? {}, partial };
}

/** Directive appended to the user prompt on resume: hand back the partial ideas
 * the killed run already wrote, tell the model to finish to 4 without
 * re-researching, then re-emit the complete list + json tail. */
function resumeContinuationBlock(partial: string): string {
  let clipped = partial.trim();
  if (clipped.length > RESUME_PARTIAL_MAX_CHARS) clipped = `${clipped.slice(0, RESUME_PARTIAL_MAX_CHARS)}\n…[truncated]`;
  return `

=== RESUMING AN INTERRUPTED RUN ===
A previous pass for this exact request was KILLED before it finished (it ran out of time / was interrupted). Below is the partial answer it had already produced. DO NOT start over and DO NOT re-research the ideas that are already complete below -- reuse them as-is. Continue from where it stopped: finish any half-written idea, add only as many NEW ideas as needed to reach EXACTLY 4 total, and run web searches only for the missing/incomplete ideas.

Then output the COMPLETE final answer from scratch: all 4 ideas in the required '## N.' markdown format (renumbered 1-4), followed by the one mandatory json tail. Do not emit only the new ideas -- emit the full, self-contained list, because the saved run replaces the partial entirely.

--- PARTIAL ANSWER FROM THE KILLED RUN ---
${clipped}
--- END PARTIAL ANSWER ---`;
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
    let lastFlush = Date.now();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      const now = Date.now();
      state.lastActivity = now;
      stdoutChunks.push(d);
      // rate-limited checkpoint of the answer-so-far, so a kill mid-stream
      // leaves a resumable partial on disk
      if (now - lastFlush >= INFLIGHT_FLUSH_MS) {
        lastFlush = now;
        void inflightFlush(stdoutChunks.join('').trim());
      }
    });
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
      const stdout = stdoutChunks.join('');
      void inflightFlush(stdout.trim()); // final checkpoint
      resolve({ code: typeof code === 'number' ? code : 0, stdout });
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
  state.resumable = false; // a fresh run supersedes any prior checkpoint
  try {
    const handle = await buildHandle(flags);
    // Open the checkpoint BEFORE spawning so a kill at any point leaves a
    // resumable trail (prompt + partial ideas streamed in by runEigen).
    await inflightBegin(handle);
    runHandleAsync(handle);
    return { ok: true, pid: state.pid ?? undefined, started: state.started };
  } catch (err) {
    state.exitCode = 1;
    append(`[start failed] ${err instanceof Error ? err.message : String(err)}\n`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    starting = false;
  }
}

/** Resume the last pass killed mid-flight: rebuild a handle from the saved
 * checkpoint (same prompt + model + meta) with a continuation directive that
 * feeds back the partial ideas, then run to a clean save. */
export async function resumeItchResearch(): Promise<StartResearchResult> {
  if (starting || running()) return { ok: false, error: 'research already running' };
  const ctx = await loadInflight();
  if (!ctx) return { ok: false, error: 'no interrupted run to resume' };
  starting = true;
  state.log = [];
  state.logOffset = 0;
  state.partial = '';
  state.exitCode = null;
  state.savedStem = null;
  state.killedReason = null;
  state.started = iso();
  state.lastActivity = Date.now();
  state.resumable = false;
  try {
    const system = ctx.system;
    const user = ctx.user + resumeContinuationBlock(ctx.partial);
    const dir = await mkdtemp(join(tmpdir(), 'atrium-itch-'));
    const promptFile = join(dir, 'prompt.md');
    await writeFile(promptFile, `${system}\n\n---\n\n${user}\n`, 'utf8');
    const handle: RunHandle = {
      model: ctx.model, promptFile, args: eigenArgsFor(ctx.model, promptFile),
      meta: ctx.meta as Record<string, unknown>, system, user,
    };
    state.log.push('[resume] continuing the interrupted run from its partial ideas');
    state.log.push(`$ eigen ${handle.args.join(' ')}  (model=${handle.model})`);
    // keep the SAME checkpoint files; reset the partial so the resumed pass
    // overwrites it (and is itself resumable if it dies again).
    await inflightBegin(handle);
    runHandleAsync(handle);
    return { ok: true, pid: state.pid ?? undefined, started: state.started };
  } catch (err) {
    state.exitCode = 1;
    append(`[resume failed] ${err instanceof Error ? err.message : String(err)}\n`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    starting = false;
  }
}

/** Shared run body for start + resume: stream eigen, then save (clearing the
 * checkpoint) on a clean finish or leave it in place when the watchdog killed
 * the pass so it can be resumed. */
function runHandleAsync(handle: RunHandle): void {
  void (async () => {
    try {
      const { code, stdout } = await runEigen(handle, (line) => append(`${line}\n`));
      if (state.partial) { state.log.push(state.partial); state.partial = ''; trimLog(); }
      const text = stdout.trim();
      let savedStem: string | null = null;
      if (state.killedReason) {
        // Killed mid-flight: keep the checkpoint, don't save a partial run.
        append('[run interrupted] partial ideas checkpointed — use resume to continue\n');
        state.resumable = (await loadInflight()) !== null;
      } else if (text) {
        try {
          savedStem = await saveRun(text, handle.meta);
          await inflightClear(); // clean save — nothing left to resume
          state.resumable = false;
        } catch (err) {
          append(`[save failed] ${err instanceof Error ? err.message : String(err)}\n`);
        }
      } else {
        await inflightClear(); // nothing useful to resume
        state.resumable = false;
      }
      state.exitCode = code;
      state.savedStem = savedStem;
    } finally {
      state.proc = null;
      state.pid = null;
      try { await unlink(handle.promptFile); } catch { /* tmp */ }
    }
  })();
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
    resumable: !running() && state.resumable,
  };
}
