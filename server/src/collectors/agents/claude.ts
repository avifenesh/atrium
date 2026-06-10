import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { iso, mtime, shTry } from '../../util.js';
import { baseAgent, type SourceResult } from './common.js';

const DAY_MS = 24 * 3600_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const SESSION_CAP = 20;

export async function collectClaude(): Promise<SourceResult> {
  const agent = baseAgent('claude', 'Claude Code');

  const pgrepOut = await shTry('pgrep', ['-fa', 'claude'], { timeoutMs: 3000 });
  const procLines = (pgrepOut ?? '')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/\bpgrep\b/.test(l) && Number(l.split(' ')[0]) !== process.pid);

  const cutoff = Date.now() - DAY_MS;
  const sessions: AgentSession[] = [];
  try {
    const entries = await readdir(config.paths.claudeProjects, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dirPath = join(config.paths.claudeProjects, e.name);
      // dir-mtime gate keeps the scan cheap: only descend into recently touched projects
      const dm = await mtime(dirPath);
      if (!dm || dm.getTime() < cutoff) continue;
      // lossy best-effort decode of the '-'-encoded cwd ('.'/'/' are indistinguishable)
      const cwd = e.name.replace(/-/g, '/');
      let files: string[] = [];
      try {
        files = await readdir(dirPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fm = await mtime(join(dirPath, f));
        if (!fm || fm.getTime() < cutoff) continue;
        const id = f.slice(0, -'.jsonl'.length);
        sessions.push({
          id,
          title: null,
          dir: cwd,
          model: null,
          status: null,
          updatedAt: iso(fm),
          live: procLines.some((l) => l.includes(` --resume ${id}`)),
        });
      }
    }
  } catch {
    /* projects dir unreadable */
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  agent.sessions = sessions.slice(0, SESSION_CAP);

  const newest = agent.sessions[0]?.updatedAt ?? null;
  const fresh = newest !== null && Date.now() - Date.parse(newest) < ACTIVE_WINDOW_MS;
  agent.status = fresh ? 'active' : procLines.length > 0 ? 'running' : 'idle';
  agent.lastActivity = newest;
  agent.detail = `${agent.sessions.length} recent sessions, ${procLines.length} claude processes`;
  return { agent, flags: [] };
}
