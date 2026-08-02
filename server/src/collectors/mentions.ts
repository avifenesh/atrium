// Mention radar — surfaces public mentions of the author's projects (HN, GitHub,
// web/blogs, YouTube, dev.to, reddit) collected hourly by ~/.local/bin/mention-radar.py
// (systemd user timer mention-radar.timer). Reads the radar's hits.jsonl tail and
// renders one link row per mention in the generic extra panel.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { store } from '../state.js';
import type { Collector } from './registry.js';
import type { ExtraRow } from '../../../shared/types.js';

const HITS_FILE = join(homedir(), '.local', 'share', 'mention-radar', 'hits.jsonl');
const MAX_ROWS = 50;

interface Hit {
  id: string;
  source: string;
  term: string;
  title: string;
  url: string;
  date: string;
}

const collector: Collector = {
  name: 'mentions',
  intervalMs: 300_000,
  async run() {
    try {
      const raw = await readFile(HITS_FILE, 'utf8');
      const hits: Hit[] = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Hit;
          } catch {
            return null;
          }
        })
        .filter((h): h is Hit => !!h?.url);
      const rows: ExtraRow[] = hits
        .slice(-MAX_ROWS)
        .reverse()
        .map((h) => ({
          label: `${h.source} · ${h.term}`,
          value: `${h.title.slice(0, 80)}${h.date ? ` — ${h.date.slice(0, 10)}` : ''}`,
          href: h.url,
          tone: 'ok',
        }));
      store.setExtra('mentions', {
        title: 'mentions',
        updatedAt: new Date().toISOString(),
        up: true,
        rows: rows.length ? rows : [{ label: 'mention-radar', value: 'no mentions recorded yet' }],
        error: null,
        data: { total: hits.length },
      });
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      store.setExtra('mentions', {
        title: 'mentions',
        updatedAt: new Date().toISOString(),
        up: missing, // no hits file yet = radar simply hasn't fired, not an outage
        rows: [{ label: 'mention-radar', value: missing ? 'no mentions recorded yet' : 'read failed' }],
        error: missing ? null : err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export default collector;
