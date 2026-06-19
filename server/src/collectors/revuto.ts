import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { loadRevutoVaultState } from '../core/revuto.js';
import { revutoSchedulerStatus } from '../core/revuto-scheduler.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { RevutoDependency, RevutoJob, RevutoLog, RevutoModel, RevutoState } from '../../../shared/types.js';
import type { Collector } from './registry.js';

// no flags here — dependency health has its own system/surreal signals; the agent card owns scheduler state.

const execFileP = promisify(execFile);

const DEPENDENCIES: Array<{ id: string; label: string }> = [
  { id: 'revuto-surreal.service', label: 'SurrealDB memory store' },
  { id: 'revuto-embedder.service', label: 'Embedder' },
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function command(cmd: string, args: string[], timeout = 10_000): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

function parseKeyValues(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

async function readDependencies(): Promise<RevutoDependency[]> {
  const stdout = await command('systemctl', [
    '--user', 'show', ...DEPENDENCIES.map((u) => u.id),
    '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState', '-p', 'ActiveEnterTimestamp',
    '--no-pager',
  ]);
  const blocks = stdout.trim().split(/\n\s*\n/).filter(Boolean).map(parseKeyValues);
  const byId = new Map(blocks.map((b) => [b.Id, b]));
  return DEPENDENCIES.map((unit) => {
    const row = byId.get(unit.id);
    return {
      id: unit.id,
      label: unit.label,
      activeState: row?.ActiveState ?? 'unknown',
      subState: row?.SubState ?? 'unknown',
      since: strOrNull(row?.ActiveEnterTimestamp),
    };
  });
}

function parseJsonResult(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeResult(result: Record<string, unknown> | null, fallback: string): string {
  if (!result) return fallback.trim().slice(0, 500);
  const keys = ['reviewed', 'skipped', 'initialized', 'limited', 'curated', 'seen', 'deleted', 'decayed'];
  const parts = keys.filter((k) => k in result).map((k) => `${k}=${String(result[k])}`);
  return parts.length ? parts.join(' / ') : JSON.stringify(result).slice(0, 500);
}

function parseLog(raw: string): RevutoLog {
  const match = raw.match(/^(\S+)\s+\S+\s+[^:]+:\s+(.*)$/);
  const message = match?.[2] ?? raw;
  const lower = message.toLowerCase();
  const level = lower.includes('failed') || lower.includes('error') || lower.includes('fail')
    ? 'error'
    : lower.includes('warn') || lower.includes('limited')
      ? 'warn'
      : 'info';
  return { timestamp: match?.[1] ?? null, level, message };
}

function parseJob(raw: string): RevutoJob | null {
  const log = parseLog(raw);
  const match = log.message.match(/^\[(review|learn|decay)\]\s+(\S+)\s+(.+?)(?:\s+\((\d+)ms\))?$/);
  if (!match) return null;
  const resultText = match[3] ?? '';
  const failed = resultText.startsWith('failed:');
  const result = failed ? null : parseJsonResult(resultText);
  return {
    timestamp: log.timestamp ?? '',
    job: match[1] as RevutoJob['job'],
    repo: match[2] ?? '',
    status: failed ? 'failed' : result ? 'ok' : 'unknown',
    durationMs: match[4] ? Number(match[4]) : null,
    summary: failed ? resultText.replace(/^failed:\s*/, '').slice(0, 500) : summarizeResult(result, resultText),
  };
}

async function readJournal(): Promise<{ jobs: RevutoJob[]; logs: RevutoLog[]; reviewed: number; skipped: number }> {
  const stdout = await command('journalctl', [
    '--user', '-u', 'atrium.service', '--since', '7 days ago', '-o', 'short-iso', '--no-pager', '-n', '3000',
  ], 10_000);
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0 && /\snode\[\d+\]:\s/.test(line));
  const jobs = lines.map(parseJob).filter((j): j is RevutoJob => !!j);
  let reviewed = 0;
  let skipped = 0;
  for (const job of jobs) {
    const mReviewed = job.summary.match(/reviewed=(\d+)/);
    const mSkipped = job.summary.match(/skipped=(\d+)/);
    if (mReviewed) reviewed += Number(mReviewed[1]);
    if (mSkipped) skipped += Number(mSkipped[1]);
  }
  return {
    jobs: jobs.slice(-60).reverse(),
    logs: lines.map(parseLog).slice(-80).reverse(),
    reviewed,
    skipped,
  };
}

async function readModels(): Promise<RevutoModel[]> {
  const cfg = await readJson<any>(join(config.paths.revutoVault, 'revuto.config.json'));
  const models = cfg?.models && typeof cfg.models === 'object' ? cfg.models : {};
  return (['review', 'curator', 'distill', 'embedder'] as const).map((role) => {
    const spec = models[role];
    const enabled = !!spec;
    return {
      role,
      enabled,
      name: enabled ? str(spec.name) : '',
      model: enabled ? str(spec.model) : '',
      probe: { state: enabled ? 'unknown' : 'disabled', ms: null, checkedAt: null, error: null },
    };
  });
}

function emptyState(): RevutoState {
  return {
    updatedAt: null, up: false, scheduler: null, counts: null, schedules: null, limits: null, store: null,
    dependencies: [], models: [], reviewers: [], jobs: [], logs: [], error: null,
  };
}

let lastGood: RevutoState | null = null;

async function run(): Promise<void> {
  try {
    const scheduler = revutoSchedulerStatus();
    const [vault, dependencies, journal, models] = await Promise.all([
      loadRevutoVaultState(config.paths.revutoVault),
      readDependencies(),
      readJournal(),
      readModels(),
    ]);
    const dependenciesReady = dependencies.filter((s) => /active|running/i.test(`${s.activeState} ${s.subState}`)).length;
    const recentFailures = journal.jobs.filter((j) => j.status === 'failed').length;
    const state: RevutoState = {
      updatedAt: iso(),
      up: scheduler.active,
      scheduler,
      counts: {
        schedulerTasks: scheduler.tasks,
        dependenciesReady,
        dependenciesTotal: dependencies.length,
        reviewers: vault.reviewers.length,
        pausedReviewers: vault.reviewers.filter((r) => r.paused).length,
        recentJobs: journal.jobs.length,
        recentFailures,
        reviewed: journal.reviewed,
        skipped: journal.skipped,
      },
      schedules: vault.schedules,
      limits: vault.limits,
      store: vault.store,
      dependencies,
      models,
      reviewers: vault.reviewers,
      jobs: journal.jobs,
      logs: journal.logs,
      error: null,
    };
    lastGood = state;
    store.setSection('revuto', state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const scheduler = revutoSchedulerStatus();
    const state: RevutoState = {
      ...emptyState(),
      ...(lastGood ?? {}),
      scheduler,
      up: scheduler.active || (lastGood?.up ?? false),
      error: msg,
    };
    store.setSection('revuto', state);
  }
}

const collector: Collector = { name: 'revuto', intervalMs: config.poll.revutoMs, run };
export default collector;
