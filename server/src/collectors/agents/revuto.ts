import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInfo } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { iso, readText } from '../../util.js';
import { baseAgent, flag, tsToMs, type SourceResult } from './common.js';

/** A handful of failures in a 180-job window is normal; spike = 10+ or ≥20% of recent jobs. */
function isFailureSpike(fails: number, jobs: number): boolean {
  return fails >= 10 || (jobs > 0 && fails / jobs >= 0.2);
}

export async function collectRevuto(): Promise<SourceResult> {
  const agent = baseAgent('revuto', 'Revuto');
  const flags: SourceResult['flags'] = [];

  agent.controls = [
    { action: 'pause', label: 'pause repo', target: '<repo>' },
    { action: 'resume', label: 'resume repo', target: '<repo>' },
    { action: 'stop', label: 'stop daemon', destructive: true },
    { action: 'start', label: 'start daemon' },
  ];

  // reviewers live in the local vault — readable even when the daemon is down
  agent.resources = await readReviewers();
  const paused = agent.resources.filter((r) => r.state === 'paused').length;
  const reviewerSummary = `${agent.resources.length} reviewers (${paused} paused)`;

  let snap: any = null;
  try {
    const res = await fetch(config.revuto.snapshotUrl, { signal: AbortSignal.timeout(3000) });
    if (res.ok) snap = await res.json();
  } catch {
    /* unreachable → off */
  }

  if (!snap) {
    agent.status = 'off';
    agent.detail = `daemon unreachable; ${reviewerSummary}`;
    flags.push(
      flag('agents:revuto-unreachable', 'warn', 'revuto unreachable', `no snapshot from ${config.revuto.snapshotUrl}`),
    );
    return { agent, flags };
  }

  const services = serviceStates(snap);
  const unhealthy = services.filter((s) => !/active|running|ok|connected|listening/i.test(s.state));
  // live snapshot exposes counts.recentJobs/recentFailures; fall back to top-level arrays
  const jobCount = countOf(snap.counts?.recentJobs ?? snap.recentJobs);
  const failCount = countOf(snap.counts?.recentFailures ?? snap.recentFailures);

  if (isFailureSpike(failCount, jobCount)) {
    agent.status = 'error';
    agent.error = `${failCount} recent failures`;
  } else if (unhealthy.length > 0) {
    agent.status = 'error';
    agent.error = `unhealthy services: ${unhealthy.map((s) => s.name).join(', ')}`;
  } else {
    agent.status = 'running';
  }

  agent.detail = `${reviewerSummary}, ${jobCount} jobs recent${failCount ? `, ${failCount} failures` : ''}`;
  const last = newestJobTs(snap);
  agent.lastActivity = last !== null ? iso(last) : null;
  return { agent, flags };
}

async function readReviewers(): Promise<AgentInfo['resources']> {
  try {
    const dir = join(config.paths.revutoVault, 'reviewers');
    const files = await readdir(dir);
    const out: AgentInfo['resources'] = [];
    for (const f of files) {
      // reviewer files are owner__repo.md; skips _index.md and other vault notes
      if (!f.endsWith('.md') || !f.includes('__')) continue;
      const id = f.slice(0, -3).replace('__', '/');
      const text = await readText(join(dir, f));
      const fmEnd = text?.startsWith('---') ? text.indexOf('\n---', 3) : -1;
      const fm = fmEnd > 0 ? text!.slice(3, fmEnd) : '';
      const isPaused = /^\s*paused:\s*true\b/m.test(fm);
      out.push({ id, name: id, state: isPaused ? 'paused' : 'active', muteable: true });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

function serviceStates(snap: any): { name: string; state: string }[] {
  const raw = snap?.services ?? snap?.systemd ?? null;
  if (Array.isArray(raw)) {
    return raw.map((s: any) => ({
      name: String(s?.id ?? s?.unit ?? s?.name ?? '?'),
      state: String(s?.activeState ?? s?.active ?? s?.state ?? s?.status ?? s?.subState ?? s?.sub ?? '?'),
    }));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([name, v]) => ({
      name,
      state: typeof v === 'string' ? v : String((v as any)?.state ?? (v as any)?.active ?? (v as any)?.status ?? '?'),
    }));
  }
  return [];
}

function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
}

function newestJobTs(snap: any): number | null {
  const jobs = Array.isArray(snap?.recentJobs) ? snap.recentJobs : Array.isArray(snap?.jobs) ? snap.jobs : [];
  let best: number | null = null;
  for (const j of jobs) {
    for (const k of ['timestamp', 'finishedAt', 'endedAt', 'completedAt', 'updatedAt', 'startedAt', 'time', 'ts', 'at']) {
      const ms = tsToMs(j?.[k]);
      if (ms !== null && (best === null || ms > best)) best = ms;
    }
  }
  return best;
}
