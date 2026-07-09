import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';

const MAX_BODY = 128 * 1024;
const ROUTES = new Map([
  ['GET feed', true],
  ['GET health', true],
  ['POST event', true],
]);

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Same-origin adapter for Streampile. Ranking, theme selection, persistence, and
 * feedback remain owned by the FastAPI service; Atrium only exposes the narrow
 * browser contract needed by the shared workspace UI.
 */
export async function proxyStreampile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const rest = url.pathname.slice('/api/streampile/'.length);
  if (!ROUTES.has(`${method} ${rest}`)) return json(res, 404, { error: 'unknown streampile route' });

  const headers: Record<string, string> = { accept: 'application/json' };
  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string') headers['content-type'] = contentType;

  let body: Buffer | undefined;
  if (method === 'POST') {
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

  await new Promise<void>((resolve) => {
    const upstream = request(config.streampile.base + '/' + rest + url.search, { method, headers });
    let settled = false;
    const timer = setTimeout(() => upstream.destroy(new Error('timeout')), 30_000);
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      json(res, 502, { error: 'streampile unavailable', detail: message });
      resolve();
    };
    upstream.on('error', (err) => fail(err instanceof Error ? err.message : String(err)));
    upstream.on('response', (up) => {
      const chunks: Buffer[] = [];
      up.on('data', (chunk: Buffer) => chunks.push(chunk));
      up.on('error', (err) => fail(err instanceof Error ? err.message : String(err)));
      up.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.writeHead(up.statusCode ?? 502, {
          'content-type': up.headers['content-type'] ?? 'application/json',
          'cache-control': 'no-store',
        });
        res.end(Buffer.concat(chunks));
        resolve();
      });
    });
    if (body) upstream.write(body);
    upstream.end();
  });
}
