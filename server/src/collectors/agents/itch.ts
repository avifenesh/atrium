import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import { ago, iso, mtime } from '../../util.js';
import { baseAgent, type SourceResult } from './common.js';

const PORTS = [8799, 8765];

export async function collectItch(): Promise<SourceResult> {
  const agent = baseAgent('itch', 'Itch');

  let newest: Date | null = null;
  try {
    const files = await readdir(config.paths.itchRuns);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const m = await mtime(join(config.paths.itchRuns, f));
      if (m && (!newest || m > newest)) newest = m;
    }
  } catch {
    /* no runs dir yet */
  }

  const up = (await Promise.all(PORTS.map(probe))).some(Boolean);
  agent.status = up ? 'running' : 'off';
  agent.lastActivity = newest ? iso(newest) : null;
  agent.detail = newest ? `last run ${ago(newest)}` : 'no runs';
  return { agent, flags: [] };
}

async function probe(port: number): Promise<boolean> {
  try {
    // any HTTP response (even an error status) means something is listening
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) });
    return true;
  } catch {
    return false;
  }
}
