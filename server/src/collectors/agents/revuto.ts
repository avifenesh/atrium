import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInfo } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { store } from '../../state.js';
import { iso, readText } from '../../util.js';
import { baseAgent, tsToMs, type SourceResult } from './common.js';

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
    { action: 'trigger', label: 'run review now', target: '<repo>' },
    { action: 'learn', label: 'run learn now', target: '<repo>' },
    { action: 'decay', label: 'run decay now', target: '<repo>' },
    { action: 'review', label: 'review PR now', target: '<repo>#<pr>' },
    { action: 'doctor', label: 'doctor' },
    { action: 'stop', label: 'stop scheduler', destructive: true },
    { action: 'start', label: 'start scheduler' },
    { action: 'restart', label: 'reload scheduler' },
  ];

  // reviewers live in the local vault; scheduler liveness comes from revuto.service.
  agent.resources = await readReviewers();
  const paused = agent.resources.filter((r) => r.state === 'paused').length;
  const reviewerSummary = `${agent.resources.length} reviewers (${paused} paused)`;

  const snap = store.get().revuto;
  const scheduler = snap.scheduler;
  const jobCount = snap.jobs.length;
  const failCount = snap.jobs.filter((j: { status: string }) => j.status === 'failed').length;

  if (!scheduler?.active && !snap.updatedAt) {
    agent.status = 'unknown';
    agent.detail = `scheduler not initialized yet; ${reviewerSummary}`;
    return { agent, flags };
  }

  if (isFailureSpike(failCount, jobCount)) {
    agent.status = 'error';
    agent.error = `${failCount} recent failures`;
  } else {
    agent.status = (scheduler?.tasks ?? 0) > 0 ? 'running' : 'idle';
  }
  agent.detail =
    `${reviewerSummary}, ${scheduler?.tasks ?? 0} cron tasks, ${jobCount} jobs recent${failCount ? `, ${failCount} failures` : ''}`;
  const last = newestJobTs({ jobs: snap.jobs });
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
