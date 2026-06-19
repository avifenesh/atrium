import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { handleLocalItch } from './itch-local.js';

// transparent proxy: /api/itch/<rest> -> itch UI server /api/<rest>. The itch server
// requires 'X-Itch-Request: 1' on mutations and rejects cross-origin Origin/Referer —
// we inject the header and never forward browser identity headers, so the upstream
// always sees a clean local client. Atrium's own Host/Origin guards run before this,
// so mutations inherit the same CSRF protection as every other route.

const REST_RE = /^[A-Za-z0-9._/-]+$/;
// synchronous AI oneshots block until the model answers — give them a long leash.
const LONG_RE = /^(ask|roadmap|validate|contrib|agent|run\/[^/]+\/(howto|scope))$/;
// research/baseline starts block too, but only on upstream auto-setup (~25s wait
// per local service) plus the spawn — ~55s real ceiling, no model call, so a
// middle tier: room for setup without the full oneshot leash.
const MED_RE = /^(research\/start|run\/[^/]+\/baseline)$/;
const MAX_BODY = 1024 * 1024;

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function proxyItch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
    return json(res, 405, { error: 'method not allowed' });
  }

  const rest = url.pathname.slice('/api/itch/'.length);
  if (!REST_RE.test(rest) || rest.split('/').includes('..')) {
    return json(res, 400, { error: 'bad path' });
  }
  if (await handleLocalItch(req, res, rest)) return;

  // build headers fresh — never forward Origin/Referer/Host/Cookie from the client
  const headers: Record<string, string> = {};
  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string') headers['content-type'] = contentType;
  if (method !== 'GET') headers['X-Itch-Request'] = '1';

  let body: Buffer | undefined;
  if (method !== 'GET') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return json(res, 413, { error: 'body too large' });
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
    headers['content-length'] = String(body.byteLength);
  }

  const timeoutMs = LONG_RE.test(rest) ? 660_000 : MED_RE.test(rest) ? 120_000 : 30_000;

  // node:http, not fetch: undici's default headersTimeout is a hard 300s, so a >5min
  // synchronous AI oneshot dies with UND_ERR_HEADERS_TIMEOUT no matter what AbortSignal
  // we pass. Plain loopback HTTP/1.1 has no such ceiling — our own timer is the only limit.
  await new Promise<void>((resolve) => {
    const upstream = request(config.itch.base + '/api/' + rest + url.search, { method, headers });
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      upstream.destroy(); // surfaces as 'error' below
    }, timeoutMs);
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) json(res, 504, { error: `itch timed out after ${timeoutMs / 1000}s` });
      else json(res, 502, { error: 'itch unreachable: ' + msg });
      resolve();
    };
    upstream.on('error', (err) => fail(err instanceof Error ? err.message : String(err)));
    upstream.on('response', (up) => {
      const chunks: Buffer[] = [];
      up.on('data', (c: Buffer) => chunks.push(c));
      up.on('error', (err) => fail(err instanceof Error ? err.message : String(err)));
      up.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.writeHead(up.statusCode ?? 502, { 'content-type': up.headers['content-type'] ?? 'application/json' });
        res.end(Buffer.concat(chunks));
        resolve();
      });
    });
    if (body) upstream.write(body);
    upstream.end();
  });
}
