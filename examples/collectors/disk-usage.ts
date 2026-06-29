// Example plugin collector — proves the contract end-to-end with zero personal deps.
//
// A collector is one module that default-exports { name, intervalMs, core?, run() }.
// Plugin collectors (core omitted / false) write the generic `extra` lane via
// store.setExtra(name, section); the web UI renders them in the generic ExtraPanel
// automatically — no React needed. Optionally raise flags via store.setFlags(name, …);
// those page the phone exactly like core flags.
//
// To use it: copy this file into server/src/collectors/, import + register it in
// server/src/index.ts alongside the others, rebuild. It will appear as a "disk" view.
// The import paths below are written for that destination (server/src/collectors/).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { store } from '../state.js';
import type { Collector } from './registry.js';
import type { ExtraRow, Flag } from '../../../shared/types.js';

const run_ = promisify(execFile);

/** Parse `df -P -BG` output into one row per mount over the warn threshold. */
function parse(stdout: string): { rows: ExtraRow[]; over: string[] } {
  const rows: ExtraRow[] = [];
  const over: string[] = [];
  for (const line of stdout.trim().split('\n').slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const usedPct = Number(cols[4].replace('%', ''));
    const mount = cols[5];
    if (!Number.isFinite(usedPct)) continue;
    rows.push({
      label: mount,
      value: `${usedPct}% of ${cols[1]}`,
      tone: usedPct >= 90 ? 'err' : usedPct >= 75 ? 'warn' : 'ok',
    });
    if (usedPct >= 90) over.push(mount);
  }
  return { rows, over };
}

const collector: Collector = {
  name: 'disk',
  intervalMs: 60_000,
  // core omitted → plugin: writes the extra lane, renders in the generic panel
  async run() {
    const flags: Flag[] = [];
    try {
      const { stdout } = await run_('df', ['-P', '-BG', '-x', 'tmpfs', '-x', 'devtmpfs'], { timeout: 10_000 });
      const { rows, over } = parse(stdout);
      store.setExtra('disk', {
        title: 'disk',
        updatedAt: new Date().toISOString(),
        up: true,
        rows: rows.sort((a, b) => a.label.localeCompare(b.label)),
        error: null,
      });
      if (over.length) {
        flags.push({
          id: 'disk:full',
          severity: 'crit',
          title: 'Disk almost full',
          detail: `${over.join(', ')} over 90%`,
          source: 'disk',
          raisedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      store.setExtra('disk', {
        title: 'disk',
        updatedAt: new Date().toISOString(),
        up: false,
        rows: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    store.setFlags('disk', flags);
  },
};

export default collector;
