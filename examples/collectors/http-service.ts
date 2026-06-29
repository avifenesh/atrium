// Example plugin collector — poll a local HTTP service and surface its health + a few
// metrics. This is the most common plugin shape: you run some daemon on localhost and
// want its liveness on the dashboard. Pure stdlib fetch, no personal dependencies.
//
// Pattern shown:
//  - liveness check with a short timeout (a down service must not stall the poll)
//  - last-good "down since" tracking so a flag's raisedAt is stable across cycles
//  - reading an optional /metrics-style JSON endpoint into ExtraRows
//  - a warn flag while the service is unreachable
//
// Copy into server/src/collectors/, set ENDPOINT (or read it from config), register in
// server/src/index.ts, rebuild. Appears as a "service" view.

import { store } from '../state.js';
import type { Collector } from './registry.js';
import type { ExtraRow, Flag } from '../../../shared/types.js';

const ENDPOINT = 'http://127.0.0.1:9000'; // ← your service's base url
const NAME = 'service';

async function getJson(path: string, timeoutMs: number): Promise<any | null> {
  try {
    const res = await fetch(`${ENDPOINT}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

let downSince: string | null = null;

const collector: Collector = {
  name: NAME,
  intervalMs: 30_000,
  // core omitted → plugin: writes the extra lane, renders in the generic panel
  async run() {
    const now = new Date().toISOString();
    const flags: Flag[] = [];

    // 1) liveness — short timeout, never throws out of run()
    let up = false;
    try {
      const health = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(2_000) });
      up = health.ok;
    } catch {
      up = false;
    }

    // 2) optional metrics, only when up
    const rows: ExtraRow[] = [];
    if (up) {
      const metrics = await getJson('/metrics', 3_000); // adapt to your service's shape
      if (metrics && typeof metrics === 'object') {
        for (const [k, v] of Object.entries(metrics).slice(0, 12)) {
          rows.push({ label: k, value: String(v) });
        }
      }
    }

    // 3) write the section
    store.setExtra(NAME, {
      title: NAME,
      updatedAt: now,
      up,
      rows,
      error: up ? null : `no healthy response from ${ENDPOINT}`,
    });

    // 4) flag while down — raisedAt stays stable so notify throttling works
    if (!up) {
      downSince ??= now;
      flags.push({
        id: `${NAME}:down`,
        severity: 'warn',
        title: `${NAME} down`,
        detail: `${ENDPOINT} unreachable`,
        source: NAME,
        raisedAt: downSince,
      });
    } else {
      downSince = null;
    }
    store.setFlags(NAME, flags);
  },
};

export default collector;
