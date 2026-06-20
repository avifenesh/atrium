import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { loadRevutoVaultState } from '../core/revuto.js';
import { store } from '../state.js';
import { iso, sh, userSystemdEnv } from '../util.js';
import type { RevutoDependency, RevutoJob, RevutoLog, RevutoModel, RevutoReviewer, RevutoState } from '../../../shared/types.js';
import type { Collector } from './registry.js';

const DEPENDENCIES: Array<{ id: string; label: string }> = [
  { id: 'revuto.service', label: 'Revuto daemon' },
  { id: 'revuto-dashboard.service', label: 'Revuto dashboard' },
  { id: 'revuto-surreal.service', label: 'SurrealDB memory store' },
  { id: 'revuto-embedder.service', label: 'Embedder' },
];

interface DashboardSnapshot {
  generatedAt: string;
  configError: string | null;
  store: { backend: string; url: string | null; namespace: string | null } | null;
  schedules: { review: string; learn: string; decay: string } | null;
  limits: { maxSteps: number; dailyReviews: number; dailyLearn: number; dailyTokens: number } | null;
  counts: {
    servicesActive: number;
    servicesTotal: number;
    reviewers: number;
    pausedReviewers: number;
    recentJobs: number;
    recentFailures: number;
    reviewed: number;
    skipped: number;
  };
  services: Array<{
    id: string;
    label: string;
    activeState: string;
    subState: string;
    since: string | null;
  }>;
  models: RevutoModel[];
  reviewers: Array<{
    repo: string;
    paused: boolean;
    autoActivate: boolean;
    schedules: { review: string; learn: string; decay: string };
  }>;
  jobs: Array<RevutoJob & { result?: Record<string, unknown> | null; raw?: string }>;
  logs: Array<RevutoLog & { raw?: string }>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function command(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  try {
    return await sh(cmd, args, { timeoutMs, env: userSystemdEnv() });
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
      since: row?.ActiveEnterTimestamp || null,
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

async function readJournal(since: string): Promise<{ jobs: RevutoJob[]; logs: RevutoLog[]; reviewed: number; skipped: number }> {
  const stdout = await command('journalctl', [
    '--user', '-u', 'revuto.service', '--since', since, '-o', 'short-iso', '--no-pager', '-n', '3000',
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
      probe: {
        state: enabled ? 'unknown' : 'disabled',
        kind: role === 'embedder' ? 'embedding' : 'chat',
        ms: null,
        checkedAt: null,
        error: null,
        sharedRoles: enabled ? [role] : [],
        responseModel: null,
        responseId: null,
      },
    };
  });
}

function emptyState(): RevutoState {
  return {
    updatedAt: null, up: false, scheduler: null, counts: null, schedules: null, limits: null, store: null,
    dependencies: [], models: [], reviewers: [], jobs: [], logs: [], error: null,
  };
}

async function readDashboardSnapshot(): Promise<DashboardSnapshot | null> {
  if (!config.revuto.snapshotUrl) return null;
  try {
    const res = await fetch(config.revuto.snapshotUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    return await res.json() as DashboardSnapshot;
  } catch {
    return null;
  }
}

function serviceActive(dependencies: RevutoDependency[], unit: string): boolean {
  const dep = dependencies.find((d) => d.id === unit);
  return dep?.activeState === 'active';
}

function toDependencies(snapshot: DashboardSnapshot, fallback: RevutoDependency[]): RevutoDependency[] {
  if (!snapshot.services.length) return fallback;
  return snapshot.services.map((service) => ({
    id: service.id,
    label: service.label,
    activeState: service.activeState,
    subState: service.subState,
    since: service.since,
  }));
}

function mapDashboardSnapshot(snapshot: DashboardSnapshot, fallbackDependencies: RevutoDependency[]): RevutoState {
  const dependencies = toDependencies(snapshot, fallbackDependencies);
  const reviewers: RevutoReviewer[] = snapshot.reviewers.map((reviewer) => ({
    repo: reviewer.repo,
    paused: reviewer.paused,
    autoActivate: reviewer.autoActivate,
    reviewSchedule: reviewer.schedules.review,
  }));
  const active = serviceActive(dependencies, 'revuto.service');
  const plan = snapshot.reviewers.map((reviewer) => ({ repo: reviewer.repo, schedules: reviewer.schedules }));
  const tasks = active ? reviewers.filter((reviewer) => !reviewer.paused).length * 3 : 0;
  return {
    updatedAt: snapshot.generatedAt,
    up: !snapshot.configError && active,
    scheduler: { active, tasks, repos: reviewers.length, plan },
    counts: {
      schedulerTasks: tasks,
      dependenciesReady: snapshot.counts.servicesActive,
      dependenciesTotal: snapshot.counts.servicesTotal,
      reviewers: snapshot.counts.reviewers,
      pausedReviewers: snapshot.counts.pausedReviewers,
      recentJobs: snapshot.counts.recentJobs,
      recentFailures: snapshot.counts.recentFailures,
      reviewed: snapshot.counts.reviewed,
      skipped: snapshot.counts.skipped,
    },
    schedules: snapshot.schedules,
    limits: snapshot.limits,
    store: snapshot.store,
    dependencies,
    models: snapshot.models,
    reviewers,
    jobs: snapshot.jobs.slice(0, 60).map((job) => ({
      timestamp: job.timestamp,
      job: job.job,
      repo: job.repo,
      status: job.status,
      durationMs: job.durationMs,
      summary: job.summary,
    })),
    logs: snapshot.logs.slice(0, 80).map((log) => ({
      timestamp: log.timestamp,
      level: log.level,
      message: log.message,
    })),
    error: snapshot.configError,
  };
}

let lastGood: RevutoState | null = null;

async function run(): Promise<void> {
  try {
    const dependencies = await readDependencies();
    const dashboard = await readDashboardSnapshot();
    if (dashboard) {
      const state = mapDashboardSnapshot(dashboard, dependencies);
      lastGood = state;
      store.setSection('revuto', state);
      return;
    }

    const daemonSince = dependencies.find((d) => d.id === 'revuto.service')?.since ?? '7 days ago';
    const [vault, journal, models] = await Promise.all([
      loadRevutoVaultState(config.paths.revutoVault),
      readJournal(daemonSince),
      readModels(),
    ]);
    const dependenciesReady = dependencies.filter((s) => /active|running/i.test(`${s.activeState} ${s.subState}`)).length;
    const recentFailures = journal.jobs.filter((j) => j.status === 'failed').length;
    const active = serviceActive(dependencies, 'revuto.service');
    const plan = vault.reviewers.map((reviewer) => ({
      repo: reviewer.repo,
      schedules: { review: reviewer.reviewSchedule, learn: vault.schedules.learn, decay: vault.schedules.decay },
    }));
    const tasks = active ? vault.reviewers.filter((reviewer) => !reviewer.paused).length * 3 : 0;
    const state: RevutoState = {
      updatedAt: iso(),
      up: active,
      scheduler: { active, tasks, repos: vault.reviewers.length, plan },
      counts: {
        schedulerTasks: tasks,
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
      error: config.revuto.snapshotUrl ? `revuto dashboard snapshot unavailable: ${config.revuto.snapshotUrl}` : null,
    };
    lastGood = state;
    store.setSection('revuto', state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const state: RevutoState = {
      ...emptyState(),
      ...(lastGood ?? {}),
      up: lastGood?.up ?? false,
      error: msg,
    };
    store.setSection('revuto', state);
  }
}

const collector: Collector = { name: 'revuto', intervalMs: config.poll.revutoMs, run };
export default collector;
