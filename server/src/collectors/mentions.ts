// Mention radar — surfaces public mentions of the author's projects (HN, GitHub,
// web/blogs, YouTube, dev.to, reddit) collected hourly by scripts/mention-radar.py
// (systemd user timer mention-radar.timer, installed by scripts/install.sh). Reads
// the radar's hits.jsonl tail and publishes each mention into the signals section.
// The watched terms live in ~/.config/atrium/signals.json (shared with the script),
// so editing them is a UI action, not a code change.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { signals } from '../signals.js';
import type { Collector } from './registry.js';
import type { SignalItem } from '../../../shared/types.js';

const HITS_FILE = join(homedir(), '.local', 'share', 'mention-radar', 'hits.jsonl');
const MAX_ROWS = 100;

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
      const items: Array<Omit<SignalItem, 'firstSeenAt'>> = hits
        .slice(-MAX_ROWS)
        .reverse()
        .map((h) => ({
          id: `mention:${h.id}`,
          source: h.source,
          kind: 'mention' as const,
          entity: h.term,
          title: h.title.slice(0, 160),
          detail: null,
          url: h.url,
          count: null,
          delta: null,
          occurredAt: h.date || null,
        }));
      await signals.publish('mentions', items, null);
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      // no hits file yet = the radar simply hasn't fired, not an outage
      await signals.publish('mentions', [], missing ? null : err instanceof Error ? err.message : String(err));
    }
  },
};

export default collector;
