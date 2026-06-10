import type { AgentSession } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { ago, iso, shTry, tailLines } from '../../util.js';
import { baseAgent, type SourceResult } from './common.js';

export async function collectCodex(): Promise<SourceResult> {
  const agent = baseAgent('codex', 'Codex');

  const [lines, pgrepOut] = await Promise.all([
    tailLines(config.paths.codexSessionIndex, 10),
    shTry('pgrep', ['-fa', 'codex'], { timeoutMs: 3000 }),
  ]);

  // pgrep -f matches any cmdline substring (bedrock_codex_bridge, ~/Documents/Codex paths) —
  // only count a standalone lowercase 'codex' token, i.e. the CLI binary itself
  const procLines = (pgrepOut ?? '')
    .split('\n')
    .filter(Boolean)
    .filter(
      (l) =>
        !/\bpgrep\b/.test(l) &&
        !/bedrock[-_]codex[-_]bridge/.test(l) &&
        /(^|[\s/])codex([\s/]|$)/.test(l.slice(l.indexOf(' ') + 1)),
    );

  const sessions: AgentSession[] = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (!j?.id || typeof j.updated_at !== 'string') continue;
      sessions.push({
        id: String(j.id),
        title: typeof j.thread_name === 'string' ? j.thread_name : null,
        dir: null,
        model: null,
        status: null,
        updatedAt: iso(j.updated_at),
        live: false,
      });
    } catch {
      /* skip bad jsonl line */
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  agent.sessions = sessions;

  const newest = sessions[0]?.updatedAt ?? null;
  agent.lastActivity = newest;
  const running = procLines.length > 0;
  const recent = newest !== null && Date.now() - Date.parse(newest) < 24 * 3600_000;
  agent.status = running ? 'running' : recent ? 'idle' : 'off';
  agent.detail = running
    ? `${procLines.length} codex process${procLines.length > 1 ? 'es' : ''}`
    : newest
      ? `off — last session ${ago(newest)}`
      : 'no sessions';
  return { agent, flags: [] };
}
