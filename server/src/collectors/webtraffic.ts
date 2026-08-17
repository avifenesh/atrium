// Web traffic — the two public sites' cookieless analytics, watched from here.
//
// The dataset (`tiyuvta_web` on Cloudflare Analytics Engine) is written by both
// properties through the shared schema in the private darklanes repo; the report
// queries were ported from darklanes ops/analytics/traffic.mjs so the owner reads
// them in atrium instead of a terminal. Everything lives in core/webtraffic.ts —
// this file is only the scheduler and the summary rows.
//
// READ-ONLY on purpose: no action is registered for this collector and none should
// be. There is nothing to act on — the numbers are the product.
//
// Fifteen minutes, not five: Analytics Engine ingests with minutes of lag and the
// reports are trailing multi-day windows, so polling faster buys nothing. No flags
// either — traffic going up or down is information, not an anomaly that pages.

import { readWebTraffic, WebTrafficUnconfigured } from '../core/webtraffic.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { ExtraRow } from '../../../shared/types.js';
import type { Collector } from './registry.js';

const count = (n: number): string => n.toLocaleString('en-US');
const signed = (n: number): string => (n > 0 ? `+${count(n)}` : count(n));

const SITE_HOST: Record<string, string> = { lab: 'tiyuvta.ai', app: 'inference.tiyuvta.ai' };

const collector: Collector = {
  name: 'webtraffic',
  intervalMs: 15 * 60_000,

  async run() {
    const now = iso();
    try {
      const report = await readWebTraffic();

      // Summary rows for the generic surfaces (MCP, palette). The bespoke panel
      // renders the full report from `data`.
      const rows: ExtraRow[] = [];
      for (const total of report.totals) {
        rows.push({
          label: `${total.site} views, ${report.days}d`,
          value: `${count(total.views)} · ${SITE_HOST[total.site] ?? total.site}`,
          href: `https://${SITE_HOST[total.site] ?? total.site}`,
        });
      }
      for (const channel of report.channels.slice(0, 5)) {
        rows.push({
          label: `  ↳ ${channel.channel}`,
          value: `${count(channel.views)} views · ${signed(channel.delta)} vs prior ${report.days}d`,
          tone: channel.delta > 0 ? 'ok' : undefined,
        });
      }

      store.setExtra('webtraffic', {
        title: 'web traffic',
        updatedAt: now,
        up: true,
        rows,
        error: null,
        data: report,
      });
    } catch (error) {
      const missingCreds = error instanceof WebTrafficUnconfigured;
      store.setExtra('webtraffic', {
        title: 'web traffic',
        updatedAt: now,
        // No credentials file is "not set up on this machine", not "analytics down" —
        // same distinction core/tiyuvta.ts draws for its bearer.
        up: missingCreds,
        rows: missingCreds
          ? [{ label: 'analytics token', value: 'not found — see core/webtraffic.ts', tone: 'warn' }]
          : [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

export default collector;
