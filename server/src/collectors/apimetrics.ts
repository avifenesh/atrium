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
  /** 5xx only — faults that are OURS. */
  errorPct: number;
  /** 429 only. On the batch-class models a shed is the CONTRACT (harvest yields to
   *  interactive and sheds retryably), so folding it into err% painted the capture rows
   *  50% red on 2026-08-28 over two designed-looking rejections. Shown separately so a
   *  real shed storm is still visible without reading as an outage. */
  shedPct: number;
  /** mean time-to-headers of successful requests — includes streaming TTFT */
  avgMs: number | null;
}

/** One hour of one model's real traffic — the health-tab chart rows. */
export interface RealUsageHour {
  hour: string; // ISO, start of hour
  model: string;
  requests: number;
  errors: number;
  sheds: number;
  /** mean time-to-headers of 2xx requests that hour */
  avgMs: number | null;
}

/** One day of one model's real traffic — the models-tab 7d counts. */
export interface RealUsageDaily {
  day: string; // YYYY-MM-DD
  model: string;
  requests: number;
  errors: number;
  sheds: number;
  avgMs: number | null;
}

type Acc = { requests: number; errors: number; sheds: number; okMsSum: number; okN: number };
const newAcc = (): Acc => ({ requests: 0, errors: 0, sheds: 0, okMsSum: 0, okN: 0 });
/** One classification for all three cuts, so a grain can never disagree with another.
 *  errors = 5xx (ours); sheds = 429 (retryable, and the batch-class contract); other 4xx
 *  are the caller's own mistakes and would drown both signals. */
function accumulate(entry: Acc, status: number, n: number, avgMs: unknown): void {
  entry.requests += n;
  if (status >= 500) entry.errors += n;
  else if (status === 429) entry.sheds += n;
  else if (status >= 200 && status < 300 && avgMs != null) {
    entry.okMsSum += Number(avgMs) * n;
    entry.okN += n;
  }
}

/** The live roster, so pre-2026-08-28 junk rows (the router used to index the CLIENT's
 *  model string verbatim: nope/nope, does-not-exist, test) fold into the same `unknown`
 *  bucket the router now writes, instead of rendering as models we serve. Analytics
 *  Engine keeps 3 months of history, so the fix at the writer alone leaves stale junk
 *  in every read until November. On fetch failure nothing folds — full data over tidy. */
async function servedRoster(): Promise<Set<string> | null> {
  try {
    const response = await fetch('https://api.tiyuvta.ai/v1/models', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const doc = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (doc.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
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

    const roster = await servedRoster();
    const fold = (model: string): string => (roster && !roster.has(model) ? 'unknown' : model);
    const byModel = new Map<string, Acc>();
    for (const row of rows) {
      const model = fold(row.model);
      const entry = byModel.get(model) ?? newAcc();
      accumulate(entry, Number(row.status) || 0, Number(row.n) || 0, row.avgMs);
      byModel.set(model, entry);
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
        const byKey = new Map<string, Acc>();
        for (const row of raw) {
          const hour = String(row.hour ?? '').replace(' ', 'T');
          if (!hour) continue;
          const key = `${hour}|${fold(row.model)}`;
          const entry = byKey.get(key) ?? newAcc();
          accumulate(entry, Number(row.status) || 0, Number(row.n) || 0, row.avgMs);
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
              sheds: Math.round(e.sheds),
              avgMs: e.okN > 0 ? Math.round(e.okMsSum / e.okN) : null,
            };
          })
          .sort((a, b) => a.hour.localeCompare(b.hour));
      }
    } catch {
      /* charts degrade to empty; the 24h totals above still render */
    }

    // daily cut over 7d — the models-tab "counted requests to each model".
    // Same dataset, day grain: cheap, and it answers "which model earns its box"
    // without anyone summing hourly rows by eye.
    const dailySql = `
      SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
             blob2 AS model, blob3 AS status,
             SUM(_sample_interval) AS n,
             SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avgMs
      FROM tiyuvta_api
      WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob2 != ''
      GROUP BY day, model, status ORDER BY day ASC
      FORMAT JSON`;
    let daily: RealUsageDaily[] = [];
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.account}/analytics_engine/sql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.token}` },
        body: dailySql,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const raw = ((await response.json()) as { data?: Array<SqlRow & { day?: string }> }).data ?? [];
        const byKey = new Map<string, Acc>();
        for (const row of raw) {
          const day = String(row.day ?? '').slice(0, 10);
          if (!day) continue;
          const key = `${day}|${fold(row.model)}`;
          const entry = byKey.get(key) ?? newAcc();
          accumulate(entry, Number(row.status) || 0, Number(row.n) || 0, row.avgMs);
          byKey.set(key, entry);
        }
        daily = [...byKey.entries()]
          .map(([key, e]) => {
            const [day, model] = key.split('|');
            return {
              day,
              model,
              requests: Math.round(e.requests),
              errors: Math.round(e.errors),
              sheds: Math.round(e.sheds),
              avgMs: e.okN > 0 ? Math.round(e.okMsSum / e.okN) : null,
            };
          })
          .sort((a, b) => a.day.localeCompare(b.day));
      }
    } catch {
      /* the 24h view still renders without the 7d cut */
    }

    const models: RealUsageModel[] = [...byModel.entries()]
      .map(([model, e]) => ({
        model,
        requests24h: Math.round(e.requests),
        errorPct: e.requests > 0 ? Math.round((e.errors / e.requests) * 1000) / 10 : 0,
        shedPct: e.requests > 0 ? Math.round((e.sheds / e.requests) * 1000) / 10 : 0,
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
        value: `${m.requests24h} req 24h · ${m.errorPct}% err · ${m.shedPct}% shed · avg ${m.avgMs ?? '—'}ms to headers`,
      })),
      data: { models, hourly, daily },
    });
  },
};

export default collector;
