import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { store } from './state.js';
import { register, startAll, runOnce, list } from './collectors/registry.js';
import { mutes } from './mutes.js';
import { loadMetricHistory } from './metric-history.js';
import { runAgentAction } from './actions.js';
import { dispatchToEigen } from './eigen-dispatch.js';
import { markNotificationRead } from './github-actions.js';
import { githubItemDetail, githubComment } from './github-detail.js';
import { writeNote } from './collectors/notes.js';
import { googleStatus, googleAuthUrl, googleCallback } from './google.js';
import { spotifySetClient, spotifyAuthUrl, spotifyCallback } from './spotify.js';
import { readNote } from './collectors/notes.js';
import type { MuteRequest } from '../../shared/types.js';

import githubCollector from './collectors/github.js';
import agentsCollector from './collectors/agents.js';
import systemCollector from './collectors/system.js';
import scheduleCollector from './collectors/schedule.js';
import commsCollector from './collectors/comms.js';
import subsCollector from './collectors/subs.js';
import notesCollector from './collectors/notes.js';
import surrealCollector from './collectors/surreal.js';

for (const c of [
  githubCollector,
  agentsCollector,
  systemCollector,
  scheduleCollector,
  commsCollector,
  subsCollector,
  notesCollector,
  surrealCollector,
]) {
  register(c);
}

const sseClients = new Set<ServerResponse>();

store.on('section', (section: string, data: unknown) => {
  const msg = `event: section\ndata: ${JSON.stringify({ section, data })}\n\n`;
  for (const res of sseClients) {
    // a write racing socket teardown emits 'error'; unguarded that kills the daemon
    if (res.writableEnded || res.destroyed) {
      sseClients.delete(res);
      continue;
    }
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
});

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Loopback binding alone does not stop DNS rebinding (attacker.com → 127.0.0.1) or
// CSRF via CORS-"simple" requests (text/plain POST needs no preflight, and
// /api/eigen/dispatch spawns an agent with the user's credentials). Standard
// localhost-daemon defense: strict Host allowlist on every request, plus
// same-origin-or-absent Origin on state-changing methods.
const ALLOWED_HOSTS = new Set(
  [config.host, '127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${config.port}`),
);
// the vite dev server (changeOrigin proxies /api with the backend host, but the
// browser still sends its own Origin) — allow its loopback origin too
const ALLOWED_ORIGIN_HOSTS = new Set([...ALLOWED_HOSTS, '127.0.0.1:5173', 'localhost:5173', '[::1]:5173']);

function hostAllowed(host: string | undefined): boolean {
  return !!host && ALLOWED_HOSTS.has(host.toLowerCase());
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients and some same-origin requests omit it
  try {
    return ALLOWED_ORIGIN_HOSTS.has(new URL(origin).host.toLowerCase());
  } catch {
    return false; // includes Origin: null
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
  if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req.headers.origin)) {
    return json(res, 403, { error: 'cross-origin request rejected' });
  }

  try {
    if (method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });

    if (method === 'GET' && path === '/api/snapshot') return json(res, 200, store.get());

    if (method === 'GET' && path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(store.get())}\n\n`);
      sseClients.add(res);
      res.on('error', () => {
        sseClients.delete(res);
      });
      const ping = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        try {
          res.write(': ping\n\n');
        } catch {
          /* socket tearing down — close handler cleans up */
        }
      }, 25_000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (method === 'POST' && path === '/api/mutes') {
      // malformed JSON is a bad request — {} fails mutes.add shape validation → 400
      const body = (await readBody(req).catch(() => ({}))) as MuteRequest;
      try {
        const mute = await mutes.add(body);
        return json(res, 201, mute);
      } catch (err) {
        // mutes.add only throws on shape validation — bad request, not server fault
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'DELETE' && path.startsWith('/api/mutes/')) {
      const id = decodeURIComponent(path.slice('/api/mutes/'.length));
      await mutes.remove(id);
      return json(res, 200, { ok: true });
    }

    const agentAction = path.match(/^\/api\/agents\/([^/]+)\/([^/]+)$/);
    if (method === 'POST' && agentAction) {
      const body = await readBody(req).catch(() => ({}));
      const result = await runAgentAction(agentAction[1], agentAction[2], body?.target);
      return json(res, result.ok ? 200 : 500, result);
    }

    const refresh = path.match(/^\/api\/refresh\/([^/]+)$/);
    if (method === 'POST' && refresh) {
      const ok = await runOnce(refresh[1]);
      return json(res, ok ? 200 : 404, { ok, collectors: list() });
    }

    if (method === 'POST' && path === '/api/eigen/dispatch') {
      const body = await readBody(req).catch(() => ({}));
      try {
        const dispatch = await dispatchToEigen(body);
        void runOnce('agents');
        return json(res, 200, dispatch);
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/notifications/read') {
      const body = await readBody(req).catch(() => ({}));
      const result = await markNotificationRead(body);
      if (result.ok) void runOnce('github');
      // client-input failures are 400; gh/api failures are the server's 500
      return json(res, result.ok ? 200 : result.badRequest ? 400 : 500, result);
    }

    if (method === 'GET' && path === '/api/google/status') return json(res, 200, await googleStatus());

    if (method === 'GET' && path === '/api/google/auth-url') {
      try {
        return json(res, 200, { url: await googleAuthUrl() });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'GET' && path === '/api/github/item') {
      try {
        const detail = await githubItemDetail(url.searchParams.get('repo') ?? '', url.searchParams.get('number') ?? '');
        return json(res, 200, detail);
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/github/comment') {
      const body = await readBody(req).catch(() => ({}));
      const result = await githubComment(body);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (method === 'POST' && path === '/api/notes/write') {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await writeNote(body));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json(res, msg.startsWith('conflict:') ? 409 : 400, { error: msg });
      }
    }

    if (method === 'GET' && path === '/api/notes/read') {
      const rel = url.searchParams.get('path') ?? '';
      try {
        return json(res, 200, await readNote(rel));
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/spotify/client') {
      const body = await readBody(req).catch(() => ({}));
      try {
        await spotifySetClient(body?.clientId);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'GET' && path === '/api/spotify/auth-url') {
      try {
        return json(res, 200, { url: await spotifyAuthUrl() });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'GET' && path === '/api/spotify/callback') {
      const html = await spotifyCallback(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
      void runOnce('subs');
      return;
    }

    if (method === 'GET' && path === '/api/google/callback') {
      const html = await googleCallback(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
      void runOnce('comms');
      return;
    }

    // static web ui (built assets), if present
    if (method === 'GET' && !path.startsWith('/api/')) {
      const served = await serveStatic(path, res);
      if (served) return;
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

let webDistCache: string | null | undefined;

async function findWebDist(): Promise<string | null> {
  if (webDistCache !== undefined) return webDistCache;
  const { stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  // src layout (tsx): server/src → repo root is 2 up; compiled layout (rootDir '..'):
  // server/dist/server/src → repo root is 4 up
  for (const up of [['..', '..'], ['..', '..', '..', '..']]) {
    const candidate = join(here, ...up, 'web', 'dist');
    try {
      if ((await stat(candidate)).isDirectory()) {
        webDistCache = candidate;
        return candidate;
      }
    } catch {
      /* try next layout */
    }
  }
  webDistCache = null;
  return null;
}

async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
  const { readFile } = await import('node:fs/promises');
  const { join, extname, normalize } = await import('node:path');
  const webDist = await findWebDist();
  if (!webDist) return false;
  const rel = normalize(path === '/' ? 'index.html' : path.replace(/^\//, ''));
  if (rel.startsWith('..')) return false;
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
  };
  for (const candidate of [join(webDist, rel), join(webDist, 'index.html')]) {
    try {
      const data = await readFile(candidate);
      res.writeHead(200, { 'content-type': types[extname(candidate)] ?? 'application/octet-stream' });
      res.end(data);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

await mutes.load();
await loadMetricHistory();
startAll();

server.listen(config.port, config.host, () => {
  console.log(`atrium listening on http://${config.host}:${config.port}`);
});
