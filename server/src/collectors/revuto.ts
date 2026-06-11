import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Collector } from './registry.js';
import type { RevutoState, RevutoService, RevutoModel, RevutoReviewer, RevutoJob, RevutoLog } from '../../../shared/types.js';

// no flags here — the agents collector owns 'agents:revuto-unreachable'; raising one too would double-report.

const execFileP = promisify(execFile);

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function mapSnapshot(raw: any): RevutoState {
  const counts = raw?.counts && typeof raw.counts === 'object'
    ? {
        servicesActive: num(raw.counts.servicesActive),
        servicesTotal: num(raw.counts.servicesTotal),
        reviewers: num(raw.counts.reviewers),
        pausedReviewers: num(raw.counts.pausedReviewers),
        recentJobs: num(raw.counts.recentJobs),
        recentFailures: num(raw.counts.recentFailures),
        reviewed: num(raw.counts.reviewed),
        skipped: num(raw.counts.skipped),
      }
    : null;

  const schedules = raw?.schedules && typeof raw.schedules === 'object'
    ? { review: str(raw.schedules.review), learn: str(raw.schedules.learn), decay: str(raw.schedules.decay) }
    : null;

  const limits = raw?.limits && typeof raw.limits === 'object'
    ? {
        maxSteps: num(raw.limits.maxSteps),
        dailyReviews: num(raw.limits.dailyReviews),
        dailyLearn: num(raw.limits.dailyLearn),
        dailyTokens: num(raw.limits.dailyTokens),
      }
    : null;

  const storeInfo = raw?.store && typeof raw.store === 'object'
    ? { backend: str(raw.store.backend), url: strOrNull(raw.store.url), namespace: strOrNull(raw.store.namespace) }
    : null;

  const services: RevutoService[] = arr(raw?.services).map((s) => ({
    id: str(s?.id),
    label: str(s?.label),
    kind: pick(s?.kind, ['service', 'timer'] as const, 'service'),
    activeState: str(s?.activeState),
    subState: str(s?.subState),
    since: strOrNull(s?.since),
    nextElapse: strOrNull(s?.nextElapse),
  }));

  const models: RevutoModel[] = arr(raw?.models).map((m) => ({
    role: pick(m?.role, ['review', 'curator', 'distill', 'embedder'] as const, 'review'),
    enabled: !!m?.enabled,
    name: str(m?.name),
    model: str(m?.model),
    probe: {
      state: pick(m?.probe?.state, ['ok', 'failed', 'disabled', 'unknown'] as const, 'unknown'),
      ms: typeof m?.probe?.ms === 'number' ? m.probe.ms : null,
      checkedAt: strOrNull(m?.probe?.checkedAt),
      error: strOrNull(m?.probe?.error),
    },
  }));

  const reviewers: RevutoReviewer[] = arr(raw?.reviewers).map((r) => ({
    repo: str(r?.repo),
    paused: !!r?.paused,
    autoActivate: !!r?.autoActivate,
    reviewSchedule: str(r?.schedules?.review),
  }));

  const jobs: RevutoJob[] = arr(raw?.jobs).slice(0, 60).map((j) => ({
    timestamp: str(j?.timestamp),
    job: pick(j?.job, ['review', 'learn', 'decay'] as const, 'review'),
    repo: str(j?.repo),
    status: pick(j?.status, ['ok', 'failed', 'unknown'] as const, 'unknown'),
    durationMs: typeof j?.durationMs === 'number' ? j.durationMs : null,
    summary: str(j?.summary),
  }));

  const logs: RevutoLog[] = arr(raw?.logs).slice(0, 80).map((l) => ({
    timestamp: strOrNull(l?.timestamp),
    level: pick(l?.level, ['info', 'warn', 'error'] as const, 'info'),
    message: str(l?.message),
  }));

  return {
    updatedAt: iso(),
    up: true,
    counts,
    schedules,
    limits,
    store: storeInfo,
    services,
    models,
    reviewers,
    jobs,
    logs,
    error: strOrNull(raw?.configError),
  };
}

// updatedAt stays null — never-collected must not read as "last data <poll cadence> ago"
function emptyState(): RevutoState {
  return {
    updatedAt: null, up: false, counts: null, schedules: null, limits: null, store: null,
    services: [], models: [], reviewers: [], jobs: [], logs: [], error: null,
  };
}

let lastGood: RevutoState | null = null;
let lastStartAttempt = 0;

// the dashboard is the data source; its unit is enabled but can be down after boot races —
// the desktop launcher does exactly this, so mirror it here (throttled, errors swallowed).
async function tryStartDashboard(): Promise<void> {
  const now = Date.now();
  if (now - lastStartAttempt < 600_000) return;
  lastStartAttempt = now;
  try {
    await execFileP('systemctl', ['--user', 'start', 'revuto-dashboard.service'], { timeout: 5_000 });
  } catch {
    /* best effort — next poll reports the failure either way */
  }
}

async function run(): Promise<void> {
  try {
    // first snapshot after dashboard boot runs model probes (~6s) — keep the timeout generous
    const res = await fetch(config.revuto.snapshotUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`snapshot returned ${res.status}`);
    const state = mapSnapshot(await res.json());
    lastGood = state;
    store.setSection('revuto', state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // keep lastGood's updatedAt so "last data" shows real staleness, not the poll cadence
    const state: RevutoState = lastGood ? { ...lastGood } : emptyState();
    state.up = false;
    state.error = msg;
    store.setSection('revuto', state);
    void tryStartDashboard();
  }
}

const collector: Collector = { name: 'revuto', intervalMs: config.poll.revutoMs, run };
export default collector;
