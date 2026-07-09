import type { ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { config } from './config.js';

const EMBED_THEME = `
<style id="atrium-workspace-theme">
  :root {
    --bg0:#0a0e14 !important; --bg1:#0e141d !important;
    --glass:rgba(14,20,29,.88) !important; --glass-brd:rgba(255,255,255,.09) !important;
    --ink:#e8edf4 !important; --ink-dim:#8b96a5 !important; --accent:#f0b35e !important;
  }
  html,body { background:#0a0e14 !important; }
  #topbar,#legend { box-shadow:0 14px 44px -28px rgba(0,0,0,.9),inset 0 1px rgba(255,255,255,.05) !important; }
  #title { background:none !important; color:#e8edf4 !important; -webkit-text-fill-color:currentColor !important; font-weight:600 !important; }
  #title .dot { color:#6fd0a8 !important; -webkit-text-fill-color:#6fd0a8 !important; }
  .chip .swatch,#legend .swatch,#panel-kicker .swatch { box-shadow:none !important; }
  #panel { background:rgba(10,14,20,.96) !important; }
  #panel-body h2,#panel-body h3 { color:#d8dee8 !important; }
  #panel-body p,#panel-body li { color:#c0c8d4 !important; }
  #panel-body a,#panel-body a.wikilink { color:#8eb1d1 !important; }
</style>`;

let cached: { mtimeMs: number; html: Buffer } | null = null;

/** Serve LLM Wiki's generated artifact inside the Atrium endpoint. */
export async function serveWikiViewer(res: ServerResponse, headOnly = false): Promise<void> {
  try {
    const info = await stat(config.wiki.viewerPath);
    if (!cached || cached.mtimeMs !== info.mtimeMs) {
      const raw = await readFile(config.wiki.viewerPath, 'utf8');
      cached = {
        mtimeMs: info.mtimeMs,
        html: Buffer.from(raw.replace('</head>', `${EMBED_THEME}\n</head>`), 'utf8'),
      };
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(cached.html.byteLength),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(headOnly ? undefined : cached.html);
  } catch (err) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta name="color-scheme" content="dark"><body style="background:#0a0e14;color:#8b96a5;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">Knowledge view unavailable: ${escapeHtml(err instanceof Error ? err.message : String(err))}</body>`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}
