import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AgentSession } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { iso, readJson } from '../../util.js';
import { baseAgent, type SourceResult } from './common.js';

const SESSION_CAP = 20;
const ACTIVE_WINDOW_MS = 5 * 60_000;

interface ActiveRow {
  session_id?: unknown;
  cwd?: unknown;
  pid?: unknown;
}

interface SqliteRow {
  session_id: string;
  cwd: string | null;
  updated_at: number;
  title: string | null;
}

function sessionsFromSqlite(): SqliteRow[] {
  const path = join(config.paths.grokSessions, 'session_search.sqlite');
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        'SELECT session_id, cwd, updated_at, title FROM session_docs ORDER BY updated_at DESC LIMIT ?',
      )
      .all(SESSION_CAP) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const id = typeof row.session_id === 'string' ? row.session_id : '';
      if (!id || !/^[A-Za-z0-9_.-]{1,200}$/.test(id)) return [];
      const updated = Number(row.updated_at);
      return [
        {
          session_id: id,
          cwd: typeof row.cwd === 'string' ? row.cwd : null,
          updated_at: Number.isFinite(updated) ? updated : 0,
          title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null,
        },
      ];
    });
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

export async function collectGrok(): Promise<SourceResult> {
  const agent = baseAgent('grok', 'Grok');

  const active = (await readJson<ActiveRow[]>(config.paths.grokActiveSessions)) ?? [];
  const liveById = new Map<string, ActiveRow>();
  if (Array.isArray(active)) {
    for (const row of active) {
      const id = typeof row?.session_id === 'string' ? row.session_id : '';
      if (id && /^[A-Za-z0-9_.-]{1,200}$/.test(id)) liveById.set(id, row);
    }
  }

  const seen = new Set<string>();
  const sessions: AgentSession[] = [];

  for (const [id, row] of liveById) {
    seen.add(id);
    const cwd = typeof row.cwd === 'string' ? row.cwd : null;
    const summary = cwd
      ? await readJson<{ generated_title?: unknown; session_summary?: unknown; current_model_id?: unknown; last_active_at?: unknown }>(
          join(config.paths.grokSessions, encodeURIComponent(cwd), id, 'summary.json'),
        )
      : null;
    const title =
      (typeof summary?.generated_title === 'string' && summary.generated_title) ||
      (typeof summary?.session_summary === 'string' && summary.session_summary) ||
      null;
    sessions.push({
      id,
      title,
      dir: cwd,
      model: typeof summary?.current_model_id === 'string' ? summary.current_model_id : null,
      status: 'live',
      updatedAt: typeof summary?.last_active_at === 'string' ? summary.last_active_at : iso(),
      live: true,
    });
  }

  for (const row of sessionsFromSqlite()) {
    if (seen.has(row.session_id)) continue;
    seen.add(row.session_id);
    sessions.push({
      id: row.session_id,
      title: row.title,
      dir: row.cwd,
      model: null,
      status: null,
      updatedAt: row.updated_at > 0 ? iso(row.updated_at * 1000) : iso(),
      live: false,
    });
    if (sessions.length >= SESSION_CAP) break;
  }

  sessions.sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt.localeCompare(a.updatedAt));
  agent.sessions = sessions.slice(0, SESSION_CAP);

  const newest = agent.sessions[0]?.updatedAt ?? null;
  const fresh = newest !== null && Date.now() - Date.parse(newest) < ACTIVE_WINDOW_MS;
  const liveCount = agent.sessions.filter((s) => s.live).length;
  agent.status = liveCount > 0 ? 'active' : fresh ? 'idle' : agent.sessions.length > 0 ? 'idle' : 'off';
  agent.lastActivity = newest;
  agent.detail = liveCount
    ? `${liveCount} live session${liveCount === 1 ? '' : 's'}, ${agent.sessions.length} recent`
    : `${agent.sessions.length} recent sessions`;
  return { agent, flags: [] };
}
