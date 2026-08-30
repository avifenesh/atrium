// Real-user model × box traffic from the tiyuvta_api Analytics Engine dataset.
//
// The api-router Worker writes one row per /v1/ request (probes excluded at the
// router by x-tiyuvta-probe). POSITIONAL COLUMN MAP — append-only, never
// reordered (tiyuvta_web law; the write side is darklanes
// workers/api-router/src/index.ts recordMetric):
//
//   blob1  path
//   blob2  model ('' when the request had none)
//   blob3  HTTP status
//   blob4  serving origin — 'primary' (rows before 2026-08-30 say 'de', its
//          one-time box nickname) / 'nj' / a pinned origin's hostname
//          (e.g. ornith-api.tiyuvta.ai). '' on every row written before the
//          column landed (2026-08-23 ~16:45Z); those are counted apart as
//          pre-blob4 rather than attributed to any box.
//   double1  duration ms (time to response headers — streaming TTFT)
//
// This is the capacity-reallocation read (owner order 2026-08-23): which model
// is getting requests on which box — e.g. "if everyone uses ornith, maybe the
// second box should be ornith". The tiyuvta collector folds it into the
// operator panel next to the console's per-tenant activity.
//
// Credentials: the one Cloudflare token (~/.config/tiyuvta/cloudflare.env),
// Analytics Engine SQL read — a background job reading a file, per the
// credential law. Read-only by construction: the SQL endpoint cannot write.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATASET = 'tiyuvta_api';

export class ApiUsageUnconfigured extends Error {}

async function credentials(): Promise<{ account: string; token: string }> {
  const path = join(homedir(), '.config/tiyuvta/cloudflare.env');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ApiUsageUnconfigured(`no credentials file at ${path}`);
  }
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/u);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/gu, '');
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? env.CF_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN;
  if (!account || !token) throw new ApiUsageUnconfigured(`no account id / token in ${path}`);
  return { account, token };
}

/** One SQL round-trip. UInt64 aggregates come back as STRINGS ("552"); every
 *  consumer goes through num(). */
async function query(sql: string): Promise<Array<Record<string, unknown>>> {
  const { account, token } = await credentials();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: sql,
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`AE SQL ${response.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
  return parsed.data ?? [];
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

// ---------- query builders (pure — unit tested in ../apiusage.test.ts) ----------

/** Requests and weighted p50 ms per (model, box) over a trailing window. Rows
 *  with blob4='' are NOT filtered here: the fold counts them as pre-blob4. */
export function modelBoxWindowSql(hours: number): string {
  const h = Math.max(1, Math.floor(hours));
  return `SELECT blob2 AS model, blob4 AS box,
    SUM(_sample_interval) AS n,
    quantileWeighted(0.5)(double1, _sample_interval) AS p50
    FROM ${DATASET}
    WHERE timestamp > NOW() - INTERVAL '${h}' HOUR AND blob2 != ''
    GROUP BY model, box FORMAT JSON`;
}

/** The 24h hourly series per (model, box), oldest first. Pre-blob4 rows are
 *  excluded here — an unattributable hour bucket charts as noise. */
export function modelBoxHourlySql(): string {
  return `SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
    blob2 AS model, blob4 AS box,
    SUM(_sample_interval) AS n,
    quantileWeighted(0.5)(double1, _sample_interval) AS p50
    FROM ${DATASET}
    WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob2 != '' AND blob4 != ''
    GROUP BY hour, model, box ORDER BY hour ASC FORMAT JSON`;
}

// ---------- the report ----------

export interface ModelBoxHour {
  /** ISO-ish start of hour (AE answers "YYYY-MM-DD HH:00:00"; normalised to 'T'). */
  hour: string;
  model: string;
  box: string;
  requests: number;
  p50Ms: number | null;
}

export interface ModelBoxWindow {
  model: string;
  box: string;
  requests1h: number;
  requests24h: number;
  p50Ms1h: number | null;
  p50Ms24h: number | null;
}

export interface ModelBoxUsage {
  /** One row per (model, box) seen in 24h, busiest first. */
  windows: ModelBoxWindow[];
  /** Hourly series over 24h, oldest first. */
  hours: ModelBoxHour[];
  /** 24h requests on rows that predate the box column (blob4=''): counted
   *  apart, never attributed to a box. Falls to zero as the window rolls past
   *  the 2026-08-23 cutover. */
  preBlob4Requests24h: number;
}

function p50Of(row: Record<string, unknown>, requests: number): number | null {
  if (requests <= 0) return null;
  const value = Number(row.p50);
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** Fold the three query results into the report. Pure, exported for the unit
 *  test — the pre-blob4 branch and the string-numeric coercion are the parts a
 *  refactor can silently get wrong. */
export function foldModelBoxUsage(
  rows24: Array<Record<string, unknown>>,
  rows1: Array<Record<string, unknown>>,
  hourly: Array<Record<string, unknown>>,
): ModelBoxUsage {
  const windows = new Map<string, ModelBoxWindow>();
  let preBlob4 = 0;

  for (const row of rows24) {
    const box = str(row.box);
    const requests = num(row.n);
    if (box === '') {
      preBlob4 += requests;
      continue;
    }
    const model = str(row.model);
    windows.set(`${model}|${box}`, {
      model,
      box,
      requests1h: 0,
      requests24h: requests,
      p50Ms1h: null,
      p50Ms24h: p50Of(row, requests),
    });
  }

  for (const row of rows1) {
    const box = str(row.box);
    if (box === '') continue; // cannot happen after the cutover; never attribute it
    const model = str(row.model);
    const requests = num(row.n);
    const key = `${model}|${box}`;
    const entry = windows.get(key) ?? {
      model,
      box,
      requests1h: 0,
      requests24h: 0,
      p50Ms1h: null,
      p50Ms24h: null,
    };
    entry.requests1h = requests;
    entry.p50Ms1h = p50Of(row, requests);
    windows.set(key, entry);
  }

  const hours: ModelBoxHour[] = hourly
    .map((row) => {
      const requests = num(row.n);
      return {
        hour: str(row.hour).replace(' ', 'T'),
        model: str(row.model),
        box: str(row.box),
        requests,
        p50Ms: p50Of(row, requests),
      };
    })
    .filter((row) => row.hour !== '' && row.box !== '')
    .sort((left, right) => left.hour.localeCompare(right.hour));

  return {
    windows: [...windows.values()].sort(
      (left, right) => right.requests24h - left.requests24h || right.requests1h - left.requests1h,
    ),
    hours,
    preBlob4Requests24h: preBlob4,
  };
}

/** The one named read: model × box × hour over the last 24h plus a last-1h cut.
 *  Settled rather than raced on failure, so a thrown error never leaves sibling
 *  requests still in flight behind the caller's back. */
export async function readModelBoxUsage(): Promise<ModelBoxUsage> {
  const settled = await Promise.allSettled([
    query(modelBoxWindowSql(24)),
    query(modelBoxWindowSql(1)),
    query(modelBoxHourlySql()),
  ]);
  const failed = settled.find((entry) => entry.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  const [rows24, rows1, hourly] = settled.map(
    (entry) => (entry as PromiseFulfilledResult<Array<Record<string, unknown>>>).value,
  );
  return foldModelBoxUsage(rows24, rows1, hourly);
}
