import { readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { AgentSession } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { iso, mtime, readJson, shTry } from '../../util.js';
import { baseAgent, tsToIso, type SourceResult } from './common.js';

const ACTIVE_WINDOW_MS = 5 * 60_000;

export async function collectEigen(): Promise<SourceResult> {
  const agent = baseAgent('eigen', 'Eigen');

  const [daemon, pgrepOut, standalone, observeM] = await Promise.all([
    queryDaemon(config.paths.eigenDaemonSock),
    shTry('pgrep', ['-fa', 'eigen'], { timeoutMs: 3000 }),
    readStandaloneSessions(),
    mtime(config.paths.eigenObserve),
  ]);

  const procLines = (pgrepOut ?? '')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/\bpgrep\b/.test(l) && Number(l.split(' ')[0]) !== process.pid);

  const sessions: AgentSession[] = [];
  for (const s of daemon?.sessions ?? []) {
    const id = String(s?.id ?? '');
    if (!id) continue;
    sessions.push({
      id,
      title: typeof s.title === 'string' ? s.title : null,
      dir: typeof s.dir === 'string' ? s.dir : null,
      model: typeof s.model === 'string' ? s.model : null,
      status: typeof s.status === 'string' ? s.status : null,
      updatedAt: tsToIso(s.updated) ?? iso(),
      live: s.status === 'running' || procLines.some((l) => l.includes(id)),
    });
  }

  let newestSessionMs: number | null = null;
  for (const s of standalone) {
    if (s.mtimeMs > 0 && (newestSessionMs === null || s.mtimeMs > newestSessionMs)) newestSessionMs = s.mtimeMs;
    if (sessions.some((x) => x.id === s.id)) continue;
    sessions.push({
      id: s.id,
      title: null,
      dir: typeof s.meta?.dir === 'string' ? s.meta.dir : null,
      model: typeof s.meta?.model === 'string' ? s.meta.model : null,
      status: null,
      updatedAt: iso(s.mtimeMs || Date.now()),
      live: procLines.some((l) => l.includes(s.jsonlName)),
    });
  }
  agent.sessions = sessions;

  const liveCount = sessions.filter((s) => s.live).length;
  const anyProc = procLines.length > 0;
  const fresh = newestSessionMs !== null && Date.now() - newestSessionMs < ACTIVE_WINDOW_MS;
  agent.status = anyProc && fresh ? 'active' : daemon ? 'running' : anyProc ? 'idle' : 'off';

  const tsCandidates = [newestSessionMs, observeM?.getTime() ?? null].filter((t): t is number => t !== null);
  agent.lastActivity = tsCandidates.length ? iso(Math.max(...tsCandidates)) : null;

  const bits = [`${sessions.length} sessions`];
  if (liveCount) bits.push(`${liveCount} live`);
  bits.push(daemon ? 'daemon up' : 'daemon down');
  agent.detail = bits.join(', ');
  return { agent, flags: [] };
}

interface DaemonSession {
  id?: unknown;
  title?: unknown;
  dir?: unknown;
  model?: unknown;
  status?: unknown;
  turns?: unknown;
  updated?: unknown;
}

function queryDaemon(sockPath: string): Promise<{ sessions: DaemonSession[] } | null> {
  return new Promise((resolve) => {
    const sock = createConnection(sockPath);
    let settled = false;
    let buf = '';
    let timer: NodeJS.Timeout | null = null;
    const finish = (v: { sessions: DaemonSession[] } | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    timer = setTimeout(() => finish(null), 1000);
    timer.unref();
    sock.on('connect', () => sock.write('{"op":"list"}\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const j = JSON.parse(buf.slice(0, nl));
        finish(j?.type === 'sessions' && Array.isArray(j.sessions) ? { sessions: j.sessions } : null);
      } catch {
        finish(null);
      }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

interface StandaloneSession {
  id: string;
  jsonlName: string;
  mtimeMs: number;
  meta: any;
}

async function readStandaloneSessions(): Promise<StandaloneSession[]> {
  try {
    const files = (await readdir(config.paths.eigenSessions)).filter((f) => f.endsWith('.meta.json'));
    const stats = await Promise.all(
      files.map(async (f) => {
        const jsonlName = f.slice(0, -'.meta.json'.length); // <stamp>.eigen.jsonl
        // jsonl mtime tracks actual activity; the meta sidecar is written once
        const m = (await mtime(join(config.paths.eigenSessions, jsonlName))) ?? (await mtime(join(config.paths.eigenSessions, f)));
        return { f, jsonlName, mtimeMs: m?.getTime() ?? 0 };
      }),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return Promise.all(
      stats.slice(0, 10).map(async (s) => ({
        id: s.jsonlName.replace(/\.eigen\.jsonl$/, ''),
        jsonlName: s.jsonlName,
        mtimeMs: s.mtimeMs,
        meta: await readJson<any>(join(config.paths.eigenSessions, s.f)),
      })),
    );
  } catch {
    return [];
  }
}
