// Client for the tiyuvta web-analytics dataset on Cloudflare Analytics Engine.
//
// Both public properties — the lab site (tiyuvta.ai) and the product console
// (inference.tiyuvta.ai) — write one cookieless beacon dataset, `tiyuvta_web`.
// This module is the READ side: it ports the report queries from the private
// darklanes repo (ops/analytics/traffic.mjs) so the numbers surface in atrium
// instead of a terminal. Read-only by construction: the SQL API endpoint used
// here cannot write, and no action is registered for this collector.
//
// The credential is the same file the darklanes scripts read
// (~/.config/tiyuvta/cloudflare.env — CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN,
// token scope "Account Analytics: Read"). It is never copied into atrium's config,
// so rotating it needs no change here. Same pattern as core/tiyuvta.ts.
//
// POSITIONAL COLUMN MAP — the single source of truth is darklanes
// shared/analytics/schema.ts. Columns there are append-only, never reordered;
// every query in this file addresses them by position through this one table.
// If a field is ever appended there, extend this map — do not guess positions.
//
//   index1   site
//   blob1    site            blob6   referrer path
//   blob2    event           blob7   country (ISO-3166 alpha-2)
//   blob3    path            blob8   device class
//   blob4    referrer kind   blob9   label (CTA name / outbound target)
//   blob5    referrer host   blob10  campaign slug (?c= on the landing URL)
//
//   double1  dwell ms        double3  scroll depth percent
//   double2  engaged ms      double4  viewport width

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

interface WebTrafficConfig {
  credsEnvPath: string;
  dataset: string;
  windowDays: number;
}

export function settings(): WebTrafficConfig {
  const raw = (config as unknown as { webtraffic?: Partial<WebTrafficConfig> }).webtraffic ?? {};
  const dataset = typeof raw.dataset === 'string' && /^[A-Za-z0-9_]+$/.test(raw.dataset) ? raw.dataset : 'tiyuvta_web';
  return {
    credsEnvPath: raw.credsEnvPath || join(homedir(), '.config/tiyuvta/cloudflare.env'),
    dataset,
    windowDays: typeof raw.windowDays === 'number' && raw.windowDays >= 1 ? Math.floor(raw.windowDays) : 7,
  };
}

export class WebTrafficUnconfigured extends Error {}

async function credentials(): Promise<{ account: string; token: string }> {
  const { credsEnvPath } = settings();
  let text: string;
  try {
    text = await readFile(credsEnvPath, 'utf8');
  } catch {
    throw new WebTrafficUnconfigured(`no credentials file at ${credsEnvPath}`);
  }
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/u);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/gu, '');
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? env.CF_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN;
  if (!account || !token) {
    throw new WebTrafficUnconfigured(`no account id / token in ${credsEnvPath}`);
  }
  return { account, token };
}

/** One SQL round-trip. The API answers UInt64 aggregates as STRINGS ("51"), so
 *  every consumer below goes through num(). */
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

/** Trailing window, optionally shifted back by a whole window for deltas.
 *  Days are clamped to a positive integer — they are the only interpolated value,
 *  so the builders stay injection-free by construction. */
export function windowClause(days: number, offsetDays = 0): string {
  const d = Math.max(1, Math.floor(days));
  const o = Math.max(0, Math.floor(offsetDays));
  const since = `timestamp > NOW() - INTERVAL '${d + o}' DAY`;
  return o === 0 ? since : `${since} AND timestamp <= NOW() - INTERVAL '${o}' DAY`;
}

// ---------- query builders (pure — unit tested in ../webtraffic.test.ts) ----------

/** Daily view counts per site, oldest first. */
export function dailyViewsSql(dataset: string, days: number): string {
  return `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS site, SUM(_sample_interval) AS views
    FROM ${dataset} WHERE ${windowClause(days)} AND blob2 = 'view'
    GROUP BY day, site ORDER BY day ASC`;
}

/** Most-viewed pages across both sites. */
export function topPathsSql(dataset: string, days: number, limit: number): string {
  return `SELECT blob1 AS site, blob3 AS path, SUM(_sample_interval) AS views
    FROM ${dataset} WHERE ${windowClause(days)} AND blob2 = 'view'
    GROUP BY site, path ORDER BY views DESC LIMIT ${Math.max(1, Math.floor(limit))}`;
}

/** External referrer breakout. Internal referrers are journeys, not sources, so
 *  they are excluded here — same shape as traffic.mjs "where visitors came from". */
export function referrersSql(dataset: string, days: number, limit: number): string {
  return `SELECT blob4 AS kind, blob5 AS host, SUM(_sample_interval) AS views
    FROM ${dataset} WHERE ${windowClause(days)} AND blob2 = 'view' AND blob4 != 'internal'
    GROUP BY kind, host ORDER BY views DESC LIMIT ${Math.max(1, Math.floor(limit))}`;
}

/** Raw rows for channel attribution: campaign slug + referrer kind/host per view.
 *  Classification happens in channelOf() so the campaign→channel rules live in
 *  code, not in SQL string soup. offsetDays shifts a whole window back for deltas. */
export function channelRowsSql(dataset: string, days: number, offsetDays: number): string {
  return `SELECT blob10 AS campaign, blob4 AS kind, blob5 AS host, SUM(_sample_interval) AS views
    FROM ${dataset} WHERE ${windowClause(days, offsetDays)} AND blob2 = 'view'
    GROUP BY campaign, kind, host`;
}

// ---------- channel attribution ----------

/** Which acquisition channel a view belongs to. Campaign slug wins over referrer:
 *  a ?c= on the landing URL is deliberate attribution, the referrer is inference.
 *
 *    - lab-legacy*     → 'lab-legacy'    (301s from the retired lab /inference pages;
 *                                         codes minted in darklanes site/public/_redirects)
 *    - trustedrouter*  → 'trustedrouter' (campaign OR trustedrouter.com referrer —
 *                                         the marketplace listing, Q38 repricing arc)
 *    - any other slug  → itself          (future codes surface without a code change)
 *    - no slug         → the referrer kind (search/social/aggregator/ai/dev/…)
 *
 *  Returns null for internal navigation with no campaign: a page-to-page move is a
 *  journey, not an acquisition, and counting it would drown every real channel. */
export function channelOf(campaign: string, kind: string, host: string): string | null {
  const slug = campaign.trim().toLowerCase();
  if (slug.startsWith('lab-legacy')) return 'lab-legacy';
  if (slug.startsWith('trustedrouter')) return 'trustedrouter';
  if (slug) return slug;
  const h = host.trim().toLowerCase().replace(/^www\./u, '');
  if (h === 'trustedrouter.com' || h.endsWith('.trustedrouter.com')) return 'trustedrouter';
  if (kind === 'internal') return null;
  return kind || 'direct';
}

export interface ChannelRow {
  campaign: string;
  kind: string;
  host: string;
  views: number;
}

export interface ChannelStat {
  channel: string;
  views: number;
  prevViews: number;
  delta: number;
}

/** Fold raw campaign/referrer rows from two adjacent windows into per-channel
 *  totals with deltas. A channel present in either window is reported. */
export function foldChannels(current: ChannelRow[], previous: ChannelRow[]): ChannelStat[] {
  const totals = new Map<string, { views: number; prevViews: number }>();
  const add = (rows: ChannelRow[], key: 'views' | 'prevViews') => {
    for (const row of rows) {
      const channel = channelOf(row.campaign, row.kind, row.host);
      if (channel === null) continue;
      const entry = totals.get(channel) ?? { views: 0, prevViews: 0 };
      entry[key] += row.views;
      totals.set(channel, entry);
    }
  };
  add(current, 'views');
  add(previous, 'prevViews');
  return [...totals.entries()]
    .map(([channel, t]) => ({ channel, views: t.views, prevViews: t.prevViews, delta: t.views - t.prevViews }))
    .sort((a, b) => b.views - a.views || b.prevViews - a.prevViews || a.channel.localeCompare(b.channel));
}

// ---------- the report ----------

export interface WebTrafficReport {
  days: number;
  totals: Array<{ site: string; views: number }>;
  /** oldest first; one row per (day, site) that had any views */
  daily: Array<{ day: string; site: string; views: number }>;
  topPaths: Array<{ site: string; path: string; views: number }>;
  referrers: Array<{ kind: string; host: string; views: number }>;
  channels: ChannelStat[];
}

export async function readWebTraffic(days?: number): Promise<WebTrafficReport> {
  const { dataset, windowDays } = settings();
  const window = Math.max(1, Math.floor(days ?? windowDays));

  const [daily, paths, referrers, current, previous] = await Promise.all([
    query(dailyViewsSql(dataset, window)),
    query(topPathsSql(dataset, window, 12)),
    query(referrersSql(dataset, window, 15)),
    query(channelRowsSql(dataset, window, 0)),
    query(channelRowsSql(dataset, window, window)),
  ]);

  const toChannelRow = (r: Record<string, unknown>): ChannelRow => ({
    campaign: str(r.campaign),
    kind: str(r.kind),
    host: str(r.host),
    views: num(r.views),
  });

  const dailyRows = daily.map((r) => ({
    // AE answers DateTime as "YYYY-MM-DD 00:00:00"; the day is all that matters.
    day: str(r.day).slice(0, 10),
    site: str(r.site),
    views: num(r.views),
  }));

  const totals = new Map<string, number>();
  for (const row of dailyRows) totals.set(row.site, (totals.get(row.site) ?? 0) + row.views);

  return {
    days: window,
    totals: [...totals.entries()].map(([site, views]) => ({ site, views })).sort((a, b) => b.views - a.views),
    daily: dailyRows,
    topPaths: paths.map((r) => ({ site: str(r.site), path: str(r.path), views: num(r.views) })),
    referrers: referrers.map((r) => ({ kind: str(r.kind), host: str(r.host), views: num(r.views) })),
    channels: foldChannels(current.map(toChannelRow), previous.map(toChannelRow)),
  };
}
