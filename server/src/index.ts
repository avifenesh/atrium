import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { store } from './state.js';
import { register, startAll, runOnce, list } from './collectors/registry.js';
import { mutes } from './mutes.js';
import { loadMetricHistory } from './metric-history.js';
import { runAgentAction } from './actions.js';
import { dispatchToEigen, getDispatchLog } from './eigen-dispatch.js';
import { stopPort, teachPort } from './system-ports.js';
import { init as initNotify } from './notify.js';
import { markNotificationRead } from './github-actions.js';
import { githubItemDetail, githubComment, githubReview } from './github-detail.js';
import { writeNote } from './collectors/notes.js';
import { googleStatus, googleAuthUrl, googleCallback } from './google.js';
import { spotifySetClient, spotifyAuthUrl, spotifyCallback } from './spotify.js';
import { readNote } from './collectors/notes.js';
import { reentry } from './reentry.js';
import { helper } from './helper.js';
import { signals } from './signals.js';
import { crm } from './crm.js';
import { crmOverview } from './crm-overview.js';
import { verifyAccessJwt } from './access-auth.js';
import type { MuteRequest } from '../../shared/types.js';

import githubCollector from './collectors/github.js';
import agentsCollector from './collectors/agents.js';
import systemCollector from './collectors/system.js';
import scheduleCollector from './collectors/schedule.js';
import commsCollector from './collectors/comms.js';
import subsCollector from './collectors/subs.js';
import notesCollector from './collectors/notes.js';
import surrealCollector from './collectors/surreal.js';
import revutoCollector from './collectors/revuto.js';
import itchWatchCollector from './collectors/itch-watch.js';
import cloudCollector from './collectors/cloud.js';
import backupCollector from './collectors/backup.js';
import reposCollector from './collectors/repos.js';
import mentionsCollector from './collectors/mentions.js';
import reentryCollector from './collectors/reentry.js';
import helperCollector from './collectors/helper.js';
import radarCollector from './collectors/radar.js';
import demandCollector from './collectors/demand.js';
import vastCollector from './collectors/vast.js';
import endpointCollector from './collectors/endpoint.js';
import tiyuvtaCollector from './collectors/tiyuvta.js';
import distributionCollector from './collectors/distribution.js';
import exposureCollector from './collectors/exposure.js';
import webtrafficCollector from './collectors/webtraffic.js';
import { isAction as isTiyuvtaAction, runAction as runTiyuvtaAction } from './core/tiyuvta.js';
import { proxyItch } from './itch-proxy.js';
import { proxyStreampile } from './streampile-proxy.js';
import { serveWikiViewer } from './wiki-viewer.js';

for (const c of [
  githubCollector,
  agentsCollector,
  systemCollector,
  scheduleCollector,
  commsCollector,
  subsCollector,
  notesCollector,
  surrealCollector,
  revutoCollector,
  itchWatchCollector,
  cloudCollector,
  backupCollector,
  reposCollector,
  reentryCollector,
  helperCollector,
  mentionsCollector,
  radarCollector,
  demandCollector,
  vastCollector,
  endpointCollector,
  tiyuvtaCollector,
  distributionCollector,
  exposureCollector,
  webtrafficCollector,
]) {
  register(c);
}

// publish the registered set so the web UI hides views for disabled collectors
store.setCollectors(list());

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
// /api/grok/dispatch spawns an agent with the user's credentials). Standard
// localhost-daemon defense: strict Host allowlist on every request, plus
// same-origin-or-absent Origin on state-changing methods.
//
// Tailscale Serve: allow only this node's canonical HTTPS endpoint. Do not widen
// this to short MagicDNS names, tailnet IPs, alternate ports, or *.ts.net.
const ALLOWED_HOSTS = new Set(
  [config.host, '127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${config.port}`),
);
// the vite dev server (changeOrigin proxies /api with the backend host, but the
// browser still sends its own Origin) — allow its loopback origin too
const ALLOWED_ORIGIN_HOSTS = new Set([...ALLOWED_HOSTS, '127.0.0.1:5173', 'localhost:5173', '[::1]:5173']);

const TAILNET_HOST = 'avifenesh.tail2582b9.ts.net';
const TAILNET_ORIGIN = `https://${TAILNET_HOST}`;

// The CRM public surface (Cloudflare tunnel + Access) — empty host = disabled.
// A request carrying this Host is authenticated per-request (Access JWT, verified
// here, not just at the edge) and confined to the CRM routes + built assets.
const CRM_HOST = config.crm.host.toLowerCase();
const CRM_ORIGIN = CRM_HOST ? `https://${CRM_HOST}` : '';

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return ALLOWED_HOSTS.has(h) || h === TAILNET_HOST || (CRM_HOST !== '' && h === CRM_HOST);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients and some same-origin requests omit it
  try {
    const u = new URL(origin);
    const h = u.host.toLowerCase();
    if (ALLOWED_ORIGIN_HOSTS.has(h)) return true;
    const o = origin.toLowerCase();
    return o === TAILNET_ORIGIN || (CRM_ORIGIN !== '' && o === CRM_ORIGIN);
  } catch {
    return false; // includes Origin: null
  }
}

/** What the CRM host may reach: its own API, and GETs for the built web app.
 *  Everything else on atrium — snapshot, stream, agent dispatch, notes, proxies —
 *  stays machine-only even if the tunnel forwards the request. */
function crmPathAllowed(method: string, path: string): boolean {
  if (path.startsWith('/api/')) return path.startsWith('/api/crm/');
  return method === 'GET' || method === 'HEAD';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
  if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req.headers.origin)) {
    return json(res, 403, { error: 'cross-origin request rejected' });
  }

  // Public CRM surface: authenticate EVERY request on this host, then confine it.
  // cloudflared connects from loopback, so the Host header is what identifies
  // tunnel traffic — and a spoofed local Host header just buys stricter rules.
  const isCrmHost = CRM_HOST !== '' && (req.headers.host ?? '').toLowerCase() === CRM_HOST;
  if (isCrmHost) {
    const token = req.headers['cf-access-jwt-assertion'];
    try {
      await verifyAccessJwt(typeof token === 'string' ? token : '', config.crm);
    } catch (err) {
      console.error('[crm] access denied:', err instanceof Error ? err.message : err);
      return json(res, 403, { error: 'access denied' });
    }
    if (!crmPathAllowed(method, path)) return json(res, 404, { error: 'not found' });
  }

  try {
    if (method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });

    if (method === 'GET' && path === '/api/snapshot') return json(res, 200, store.get());

    if (method === 'GET' && path === '/api/reentry/evidence') {
      return json(res, 200, reentry.buildEvidence());
    }

    if (method === 'GET' && path === '/api/helper/evidence') {
      return json(res, 200, await helper.buildEvidence());
    }

    if (method === 'POST' && path === '/api/helper/scan') {
      const result = await helper.requestScan();
      return json(res, result.ok ? 202 : 503, result);
    }

    if (method === 'POST' && path === '/api/helper/agent-result') {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, { ok: true, ...await helper.applyAgentResult(body) });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/helper/agent-error') {
      const body = await readBody(req).catch(() => ({}));
      await helper.applyAgentError(body);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/api/helper/settings') {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, await helper.updateSettings(body));
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const helperOfferAction = path.match(/^\/api\/helper\/offers\/([^/]+)\/(dismiss|snooze|launch)$/);
    if (method === 'POST' && helperOfferAction) {
      const id = decodeURIComponent(helperOfferAction[1]);
      const body = await readBody(req).catch(() => ({}));
      try {
        const result = helperOfferAction[2] === 'dismiss'
          ? await helper.dismiss(id, body)
          : helperOfferAction[2] === 'snooze'
            ? await helper.snooze(id, body)
            : await helper.launch(id, body);
        return json(res, 200, result);
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const helperMemory = path.match(/^\/api\/helper\/(preferences|skills)\/([^/]+)$/);
    if (method === 'DELETE' && helperMemory) {
      try {
        if (helperMemory[1] === 'preferences') await helper.removePreference(decodeURIComponent(helperMemory[2]));
        else await helper.removeSkill(decodeURIComponent(helperMemory[2]));
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const tiyuvtaAction = path.match(/^\/api\/tiyuvta\/([a-z-]+)$/);
    if (method === 'POST' && tiyuvtaAction) {
      const name = tiyuvtaAction[1];
      if (!isTiyuvtaAction(name)) return json(res, 404, { error: `unknown action ${name}` });
      const body = (await readBody(req).catch(() => ({}))) as { tenant?: string };
      try {
        const result = await runTiyuvtaAction(name, body?.tenant);
        // Re-poll immediately: an action that changes the numbers should not leave a
        // stale panel until the next five-minute cycle.
        void tiyuvtaCollector.run();
        return json(res, 200, { ok: true, result });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/reentry/park') {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 201, await reentry.park(body));
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/reentry/scan') {
      const result = await reentry.requestScan();
      return json(res, result.ok ? 202 : 503, result);
    }

    if (method === 'POST' && path === '/api/reentry/agent-result') {
      const body = await readBody(req).catch(() => ({}));
      try {
        await reentry.applyAgentResult(body);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/reentry/agent-error') {
      const body = await readBody(req).catch(() => ({}));
      await reentry.applyAgentError(body);
      return json(res, 200, { ok: true });
    }

    const reentryAction = path.match(/^\/api\/reentry\/([^/]+)\/(resume|archive)$/);
    if (method === 'POST' && reentryAction) {
      const id = decodeURIComponent(reentryAction[1]);
      try {
        const result = reentryAction[2] === 'resume' ? await reentry.resume(id) : await reentry.archive(id);
        return json(res, 200, result);
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

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

    const dispatchLog = path.match(/^\/api\/(?:eigen|grok)\/dispatch\/([^/]+)\/log$/);
    if (method === 'GET' && dispatchLog) {
      // id is uuid-charset validated inside getDispatchLog; null = unknown id
      const out = await getDispatchLog(dispatchLog[1]);
      return out ? json(res, 200, out) : json(res, 404, { error: 'unknown dispatch id' });
    }

    if (method === 'POST' && path === '/api/system/ports/teach') {
      const body = await readBody(req).catch(() => ({}));
      try {
        const taught = await teachPort(body);
        void runOnce('system');
        return json(res, 200, { ok: true, ...taught });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/system/ports/stop') {
      const body = await readBody(req).catch(() => ({}));
      try {
        const stopped = await stopPort(body);
        void runOnce('system');
        return json(res, 200, { ok: true, ...stopped });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && (path === '/api/eigen/dispatch' || path === '/api/grok/dispatch')) {
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

    if (method === 'POST' && path === '/api/github/review') {
      const body = await readBody(req).catch(() => ({}));
      const result = await githubReview(body);
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
      const root = url.searchParams.get('root') ?? 'vault';
      try {
        return json(res, 200, await readNote(rel, root));
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // crm — pipeline over signals + tiyuvta accounts; the one surface the
    // public CRM host may reach (see crmPathAllowed)
    if (method === 'GET' && path === '/api/crm/pipeline') {
      return json(res, 200, crm.pipeline());
    }

    // the business numbers above the pipeline — aggregated server-side so the
    // public host reads one endpoint instead of the machine-wide snapshot
    if (method === 'GET' && path === '/api/crm/overview') {
      return json(res, 200, crmOverview());
    }

    if (method === 'POST' && path === '/api/crm/entry') {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, { ok: true, entry: await crm.update(body?.id, body) });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/crm/note') {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, { ok: true, note: await crm.addNote(body?.id, body?.text) });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'POST' && path === '/api/crm/contact') {
      const body = await readBody(req).catch(() => ({}));
      try {
        return json(res, 200, { ok: true, contact: await crm.addContact(body?.id, body?.channel, body?.summary) });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // signals — the "outside world noticed my work" section
    if (method === 'POST' && path === '/api/signals/reviewed') {
      return json(res, 200, { ok: true, lastReviewedAt: await signals.markReviewed() });
    }

    if (method === 'POST' && path === '/api/signals/lead') {
      const body = await readBody(req).catch(() => ({}));
      try {
        await signals.setLead(body?.id, body?.status ?? null, body?.note);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === 'PUT' && path === '/api/signals/watch') {
      const body = await readBody(req).catch(() => ({}));
      try {
        const watch = await signals.setWatch(body);
        // feeders read the watch on every run — kick them so the change lands now
        void runOnce('radar');
        void runOnce('mentions');
        return json(res, 200, { ok: true, watch });
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

    // itch proxy — Host/Origin guards above already gate mutations, the proxy injects
    // the upstream's own anti-CSRF header and strips browser identity headers
    if (path.startsWith('/api/itch/')) return proxyItch(req, res, url);

    // Streampile keeps its own FastAPI/SurrealDB backend; this is only the
    // same-origin browser adapter for the unified workspace UI.
    if (path.startsWith('/api/streampile/')) return proxyStreampile(req, res, url);

    // LLM Wiki owns generation of this artifact. Atrium serves the latest built
    // viewer under the shared endpoint without copying wiki data into its store.
    if ((method === 'GET' || method === 'HEAD') && path === '/workspace/wiki') {
      return serveWikiViewer(res, method === 'HEAD');
    }

    // static web ui (built assets), if present. The CRM host lands on the
    // standalone CRM page, not the full dashboard SPA.
    if (method === 'GET' && !path.startsWith('/api/')) {
      const served = await serveStatic(path, res, isCrmHost ? 'crm.html' : 'index.html');
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

async function serveStatic(path: string, res: ServerResponse, fallback = 'index.html'): Promise<boolean> {
  const { readFile } = await import('node:fs/promises');
  const { join, extname, normalize } = await import('node:path');
  const webDist = await findWebDist();
  if (!webDist) return false;
  const rel = normalize(path === '/' ? fallback : path.replace(/^\//, ''));
  if (rel.startsWith('..')) return false;
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
  };
  for (const candidate of [join(webDist, rel), join(webDist, fallback)]) {
    try {
      const data = await readFile(candidate);
      const ext = extname(candidate);
      // vite assets are content-hashed (safe to cache hard); index.html is not — without
      // an explicit no-cache the browser heuristically caches it and serves stale bundles
      // after a rebuild until a manual reload
      // only assets/ files carry content hashes in their names — root files (favicon) stay revalidated
      const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': cache });
      res.end(data);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

await reentry.load();
await helper.load();
await mutes.load();
await signals.load();
await crm.load();
await loadMetricHistory();

// Loopback is a hard invariant, not a default: there is no auth layer, and
// /api/grok/dispatch spawns an agent with the user's credentials. A config.json
// host override to a LAN address would expose all of that to the network.
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(config.host)) {
  console.error(`atrium refuses to bind non-loopback host ${config.host} — no auth layer exists`);
  process.exit(2);
}

// init before startAll or boot-time crits are dropped; mutes already loaded above.
// sendCmd comes straight from config now (empty = push disabled); see examples/notify/.
initNotify(config.notify);

startAll();

server.listen(config.port, config.host, () => {
  console.log(`atrium listening on http://${config.host}:${config.port}`);
});
