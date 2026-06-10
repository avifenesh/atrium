import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import type { SystemHistory, SystemState } from '../../shared/types.js';

// Rolling utilization history for the sparklines. The browser used to accumulate
// this in tab memory, so a reload or daemon restart started the graphs empty.
// Here it lives server-side, persisted to disk, so the snapshot carries depth on
// the very first frame.

const FILE = join(config.configDir, 'metric-history.json');
const CAP = 240; // ~20 min at the 5s system poll — plenty for a 64px sparkline
const PERSIST_EVERY = 6; // write to disk roughly every 30s, not every sample

const series: SystemHistory = { cpu: [], mem: [], swap: [], gpu: [] };
let sinceWrite = 0;

function clampPush(arr: number[], v: number): void {
  arr.push(Math.round(v));
  if (arr.length > CAP) arr.shift();
}

export async function loadMetricHistory(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(FILE, 'utf8'));
    for (const k of ['cpu', 'mem', 'swap', 'gpu'] as const) {
      if (Array.isArray(saved?.[k])) {
        series[k] = saved[k].filter((n: unknown) => typeof n === 'number').slice(-CAP);
      }
    }
  } catch {
    /* first run or unreadable → start empty */
  }
}

async function persist(): Promise<void> {
  try {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(series));
    await rename(tmp, FILE);
  } catch {
    /* best effort — losing a few samples is harmless */
  }
}

/** Record one system sample into the rolling history; returns the live series to
 *  attach to the snapshot. Skip on a failed poll so bogus zeros don't enter the graph. */
export function recordMetrics(s: SystemState): SystemHistory {
  clampPush(series.cpu, s.cpu.pct);
  clampPush(series.mem, s.mem.usedPct);
  clampPush(series.swap, s.swap.usedPct);
  if (s.gpu) clampPush(series.gpu, s.gpu.utilPct);
  if (++sinceWrite >= PERSIST_EVERY) {
    sinceWrite = 0;
    void persist();
  }
  return series;
}

export function getMetricHistory(): SystemHistory {
  return series;
}
