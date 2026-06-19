import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import { itchResearchStatus } from '../../core/itch-research.js';
import { ago, iso, mtime } from '../../util.js';
import { baseAgent, type SourceResult } from './common.js';

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

  const research = itchResearchStatus();
  agent.controls = [
    { action: 'trigger', label: 'start research' },
    { action: 'stop', label: 'stop research', destructive: true },
  ];
  agent.status = research.running ? 'active' : 'running';
  agent.lastActivity = newest ? iso(newest) : null;
  agent.detail = `${research.running ? 'research running; ' : ''}${newest ? `last run ${ago(newest)}` : 'no runs'}`;
  return { agent, flags: [] };
}
