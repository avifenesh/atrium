// usagemix — what the fleet's traffic actually looks like, per model.
//
// darklanes' ops/analytics/usage.py keeps every serving box's request ledger in one archive
// on this machine (a box's own ledger dies with the box: box12 took four days of qwen with
// it on 2026-09-03) and publishes a small summary beside it. This collector INGESTS that
// summary read-only, the same seam as the serving alerts — atrium never opens the archive's
// database and never sees a tenant id.
//
// The numbers are the pricing inputs the owner asked for on 2026-09-04, per model over
// 24h / 7d / 30d / all: in:out is how many prompt tokens a caller sends per completion
// token, cachedShare is how much of the prompt the prefix cache served. Those two decide
// which price line carries revenue — on the traffic measured so far, the cached one.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import type { Collector } from './registry.js';
import type { ModelUsageMix } from '../../../shared/types.js';

function summaryPath(): string {
  const dir = config.serving.stateDir || join(homedir(), '.local', 'state', 'tiyuvta-serving');
  return join(dir, 'usage-summary.json');
}

/** The archive's timer runs every 6 h. Past this the file is stale, and a stale number that
 *  does not say so is worse than an empty panel — the same rule the sentinel tick follows. */
const STALE_MS = 12 * 60 * 60 * 1000;

const fmtInt = (n: number) => n.toLocaleString('en-US');

async function run(): Promise<void> {
  const path = summaryPath();
  let raw: string;
  let ageMs: number;
  try {
    raw = await readFile(path, 'utf8');
    ageMs = Date.now() - (await stat(path)).mtimeMs;
  } catch {
    // No archive on this machine (a laptop, a fresh install): nothing to report, not a fault.
    store.setExtra('usagemix', {
      title: 'traffic mix',
      updatedAt: null,
      up: true,
      error: null,
      rows: [{ label: 'archive', value: 'not on this machine', tone: 'warn' }],
      data: null,
    });
    return;
  }

  let parsed: ModelUsageMix;
  try {
    parsed = JSON.parse(raw) as ModelUsageMix;
  } catch (err) {
    store.setExtra('usagemix', {
      title: 'traffic mix',
      updatedAt: null,
      up: false,
      error: `usage-summary.json is not readable JSON: ${err instanceof Error ? err.message : String(err)}`,
      data: null,
    });
    return;
  }

  const staleHours = ageMs > STALE_MS ? Math.round(ageMs / 3_600_000) : null;
  const customers = parsed.models.filter((m) => m.cls === 'customer');
  const data: ModelUsageMix = { ...parsed, staleHours };

  store.setExtra('usagemix', {
    title: 'traffic mix',
    updatedAt: parsed.updatedAt ?? null,
    up: staleHours === null,
    error: null,
    rows: [
      {
        label: 'archive',
        value: parsed.archive
          ? `${fmtInt(parsed.archive.requests)} requests, ${parsed.archive.from} → ${parsed.archive.to}`
          : 'empty',
        tone: parsed.archive ? 'ok' : 'warn',
      },
      ...(staleHours === null
        ? []
        : [{ label: 'rollup', value: `${staleHours}h old — the 6h timer has stopped`, tone: 'err' as const }]),
      // One row per model a CUSTOMER actually used: the panel's tables carry the rest.
      ...customers
        .filter((m) => (m.windows['7d']?.served ?? 0) > 0)
        .map((m) => {
          const w = m.windows['7d'];
          const ratio = w.inOut === null ? '—' : `${w.inOut}:1`;
          const cache = w.cachedShare === null ? '—' : `${Math.round(w.cachedShare * 100)}% cached`;
          return {
            label: m.model.split('/').pop() ?? m.model,
            value: `7d: ${fmtInt(w.served)} req · ${ratio} in:out · ${cache}`,
            tone: 'ok' as const,
          };
        }),
    ],
    data,
  });
}

const collector: Collector = { name: 'usagemix', intervalMs: 10 * 60_000, run };
export default collector;
