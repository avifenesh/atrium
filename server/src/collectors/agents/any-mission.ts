import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import { iso, readJson } from '../../util.js';
import { baseAgent, pidAlive, tsToMs, type SourceResult } from './common.js';

const LIVE_WINDOW_MS = 60_000;

export async function collectAnyMission(): Promise<SourceResult> {
  const agent = baseAgent('any-mission', 'Any-Mission');

  let runDirs: string[] = [];
  try {
    runDirs = (await readdir(config.paths.anyMissionRuns)).filter((d) => d.startsWith('run-'));
  } catch {
    /* no runs dir */
  }

  const now = Date.now();
  let newestTs: number | null = null;
  for (const runId of runDirs) {
    const hb = await readJson<any>(join(config.paths.anyMissionRuns, runId, 'heartbeat.json'));
    if (!hb) continue;
    const ts = tsToMs(hb.ts);
    if (ts !== null && (newestTs === null || ts > newestTs)) newestTs = ts;
    const live = ts !== null && now - ts <= LIVE_WINDOW_MS && pidAlive(hb.pid);
    if (!live) continue;
    agent.sessions.push({
      id: runId,
      title: null,
      dir: join(config.paths.anyMissionRuns, runId),
      model: null,
      status: hb.iteration != null ? `iteration ${hb.iteration}` : null,
      updatedAt: iso(ts),
      live: true,
    });
    // actual kill is implemented by actions.ts; this only declares the control
    agent.controls.push({ action: 'kill', label: 'kill mission', target: runId, destructive: true });
  }

  const live = agent.sessions.length;
  agent.status = live > 0 ? 'running' : 'off';
  agent.lastActivity = newestTs !== null ? iso(newestTs) : null;
  agent.detail = live > 0 ? `${live} live mission${live > 1 ? 's' : ''}` : 'no live missions';
  return { agent, flags: [] };
}
