// Real-user API metrics — what customers actually experienced through the
// router, read back from the tiyuvta_api Analytics Engine dataset that the
// api-router Worker writes (blob1=path, blob2=model, blob3=status,
// double1=time-to-headers ms; atrium's own probes are excluded at the router
// by the x-tiyuvta-probe header).
//
// The synthetic TTFT probes (endpoint.ts) answer "is it up"; this answers
// "what did customers feel": error rate and latency of real keys, real
// prompts, real payload sizes. Both matter, neither substitutes.
//
// Credentials: the one Cloudflare token (~/.config/tiyuvta/cloudflare.env),
// which carries Analytics Engine SQL read — a background job reading a file,
// per the credential law.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Collector } from './registry.js';

export interface RealUsageModel {
  model: string;
  requests24h: number;
  errorPct: number;
  /** mean time-to-headers of successful requests — includes streaming TTFT */
  avgMs: number | null;
}

/** One hour of one model's real traffic — the health-tab chart rows. */
export interface RealUsageHour {
  hour: string; // ISO, start of hour
  model: string;
  requests: number;
  errors: number;
  /** mean time-to-headers of 2xx requests that hour */
  avgMs: number | null;
}

async function cfCreds(): Promise<{ token: string; account: string } | null> {
  try {
    const text = await readFile(resolve(homedir(), '.config/tiyuvta/cloudflare.env'), 'utf8');
    const get = (names: string[]) => {
      for (const name of names) {
        const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm'));
        const v = m?.[1]?.trim().replace(/^["']|["']$/gu, '');
        if (v) return v;
      }
      return null;
    };
    const token = get(['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN']);
    const account = get(['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']);
    return token && account ? { token, account } : null;
  } catch {
    return null;
  }
}

interface SqlRow {
  model: string;
  status: string;
  n: string | number;
  avgMs: string | number | null;
}

const collector: Collector = {
  name: 'apimetrics',
  intervalMs: 15 * 60_000,

  async run() {
    const creds = await cfCreds();
    if (!creds) {
      store.setExtra('apimetrics', { title: 'real-user api', updatedAt: iso(), up: false, error: 'no cloudflare.env', data: { models: [] } });
      return;
    }
    const sql = `
      SELECT blob2 AS model, blob3 AS status,
             SUM(_sample_interval) AS n,
             SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avgMs
      FROM tiyuvta_api
      WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob2 != ''
      GROUP BY model, status
      FORMAT JSON`;
    let rows: SqlRow[] = [];
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.account}/analytics_engine/sql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.token}` },
        body: sql,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`AE SQL ${response.status}: ${(await response.text()).slice(0, 120)}`);
      rows = ((await response.json()) as { data?: SqlRow[] }).data ?? [];
    } catch (error) {
      store.setExtra('apimetrics', {
        title: 'real-user api',
        updatedAt: iso(),
        up: false,
        error: error instanceof Error ? error.message : String(error),
        data: { models: [] },
      });
      return;
    }

    const byModel = new Map<string, { requests: number; errors: number; okMsSum: number; okN: number }>();
    for (const row of rows) {
      const entry = byModel.get(row.model) ?? { requests: 0, errors: 0, okMsSum: 0, okN: 0 };
      const n = Number(row.n) || 0;
      const status = Number(row.status) || 0;
      entry.requests += n;
      // customer-hurting outcomes: server errors and throttles; 4xx key/input
      // mistakes are the customer's own and would drown the signal
      if (status >= 500 || status === 429) entry.errors += n;
      else if (status >= 200 && status < 300 && row.avgMs != null) {
        entry.okMsSum += Number(row.avgMs) * n;
        entry.okN += n;
      }
      byModel.set(row.model, entry);
    }
    // hourly cut for the CRM health charts — same dataset, one more round-trip
    const hourlySql = `
      SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
             blob2 AS model, blob3 AS status,
             SUM(_sample_interval) AS n,
             SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avgMs
      FROM tiyuvta_api
      WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob2 != ''
      GROUP BY hour, model, status ORDER BY hour ASC
      FORMAT JSON`;
    let hourly: RealUsageHour[] = [];
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.account}/analytics_engine/sql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.token}` },
        body: hourlySql,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const raw = ((await response.json()) as { data?: Array<SqlRow & { hour?: string }> }).data ?? [];
        const byKey = new Map<string, { requests: number; errors: number; okMsSum: number; okN: number }>();
        for (const row of raw) {
          const hour = String(row.hour ?? '').replace(' ', 'T');
          if (!hour) continue;
          const key = `${hour}|${row.model}`;
          const entry = byKey.get(key) ?? { requests: 0, errors: 0, okMsSum: 0, okN: 0 };
          const n = Number(row.n) || 0;
          const status = Number(row.status) || 0;
          entry.requests += n;
          if (status >= 500 || status === 429) entry.errors += n;
          else if (status >= 200 && status < 300 && row.avgMs != null) {
            entry.okMsSum += Number(row.avgMs) * n;
            entry.okN += n;
          }
          byKey.set(key, entry);
        }
        hourly = [...byKey.entries()]
          .map(([key, e]) => {
            const [hour, model] = key.split('|');
            return {
              hour,
              model,
              requests: Math.round(e.requests),
              errors: Math.round(e.errors),
              avgMs: e.okN > 0 ? Math.round(e.okMsSum / e.okN) : null,
            };
          })
          .sort((a, b) => a.hour.localeCompare(b.hour));
      }
    } catch {
      /* charts degrade to empty; the 24h totals above still render */
    }

    const models: RealUsageModel[] = [...byModel.entries()]
      .map(([model, e]) => ({
        model,
        requests24h: Math.round(e.requests),
        errorPct: e.requests > 0 ? Math.round((e.errors / e.requests) * 1000) / 10 : 0,
        avgMs: e.okN > 0 ? Math.round(e.okMsSum / e.okN) : null,
      }))
      .sort((a, b) => b.requests24h - a.requests24h);

    store.setExtra('apimetrics', {
      title: 'real-user api',
      updatedAt: iso(),
      up: true,
      error: null,
      rows: models.map((m) => ({
        label: m.model.split('/').pop() ?? m.model,
        value: `${m.requests24h} req 24h · ${m.errorPct}% err · avg ${m.avgMs ?? '—'}ms to headers`,
      })),
      data: { models, hourly },
    });
  },
};

export default collector;
