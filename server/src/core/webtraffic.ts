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

// ---------- conversion funnel ----------
//
// Page-level funnel for the pages where money enters. Cookieless means no
// visitor id, so "landed and closed" is NOT a per-person fact — it is
// approximated in aggregate: views, minus same-site onward navigations (the
// people who provably did not close), minus CTA clicks (the people who provably
// acted). Engagement comes from the leave beacon's visible-and-focused clock.
// That trade (no session stitching, no consent banner) is deliberate and
// documented in darklanes shared/analytics/schema.ts — do not "fix" it by
// adding an id.

/** The pages worth a funnel readout. ONLY pages that load the beacon belong
 *  here: /login is the single authed-side page that opts in (console ui.ts —
 *  pages behind auth stay unbeaconed by design). /app was in the first cut and
 *  produced a permanent fake "0 views" card, because its only rows are the
 *  playground's auto-fired cta beacons — those are reported separately below
 *  as what they are, not folded into a views funnel. */
export const FUNNEL_PAGES: ReadonlyArray<{ site: string; path: string }> = [
  { site: 'app', path: '/login' },
];

/** Signed-in playground events (path /app, cta rows only — the page sends no
 *  view/leave beacons). `playground_rendered` fires on render: an impression,
 *  not an action. `playground_first_success` is a real first API round-trip. */
export const PLAYGROUND_PATH = '/app';

/** Paths are compile-time constants, but assert the shape anyway so a future
 *  config-driven page list cannot smuggle a quote into the SQL. */
function safePath(path: string): string {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new Error(`unsafe funnel path: ${path}`);
  return path;
}

const pathList = (paths: string[]): string => paths.map((p) => `'${safePath(p)}'`).join(', ');

/** Calendar-day-so-far vs trailing window: 'today' answers the owner's morning
 *  question; the week answers whether today is normal. */
export function funnelWindowClause(window: 'today' | number): string {
  return window === 'today'
    ? `timestamp > toStartOfInterval(NOW(), INTERVAL '1' DAY)`
    : windowClause(window);
}

/** Arrivals onto the funnel pages: one row per (path, referrer kind, host, from-path). */
export function funnelArrivalsSql(dataset: string, site: string, paths: string[], window: 'today' | number): string {
  return `SELECT blob3 AS path, blob4 AS kind, blob5 AS host, blob6 AS from_path, SUM(_sample_interval) AS views
    FROM ${dataset} WHERE ${funnelWindowClause(window)} AND blob2 = 'view' AND blob1 = '${site}'
    AND blob3 IN (${pathList(paths)})
    GROUP BY path, kind, host, from_path`;
}

/** Same-site navigations AWAY from the funnel pages: where people went next. */
export function funnelOnwardSql(dataset: string, site: string, paths: string[], window: 'today' | number): string {
  return `SELECT blob6 AS from_path, blob3 AS path, SUM(_sample_interval) AS views
    FROM ${dataset} WHERE ${funnelWindowClause(window)} AND blob2 = 'view' AND blob1 = '${site}'
    AND blob4 = 'internal' AND blob6 IN (${pathList(paths)}) AND blob3 != blob6
    GROUP BY from_path, path`;
}

/** Leave beacons per funnel page: how long people actually stayed. */
export function funnelLeavesSql(dataset: string, site: string, paths: string[], window: 'today' | number): string {
  // The mean is sample-weighted like every count here: a plain AVG weights
  // stored rows, not represented events, and drifts exactly on the spike days
  // (HN front page) when AE sampling engages and the owner is looking.
  return `SELECT blob3 AS path, SUM(_sample_interval) AS leaves,
      SUM(IF(double2 > 10000, _sample_interval, 0)) AS engaged10,
      SUM(double2 * _sample_interval) / SUM(_sample_interval) AS avg_engaged_ms
    FROM ${dataset} WHERE ${funnelWindowClause(window)} AND blob2 = 'leave' AND blob1 = '${site}'
    AND blob3 IN (${pathList(paths)})
    GROUP BY path`;
}

/** CTA clicks on the funnel pages, per label. */
export function funnelCtaSql(dataset: string, site: string, paths: string[], window: 'today' | number): string {
  return `SELECT blob3 AS path, blob9 AS label, SUM(_sample_interval) AS clicks
    FROM ${dataset} WHERE ${funnelWindowClause(window)} AND blob2 = 'cta' AND blob1 = '${site}'
    AND blob3 IN (${pathList(paths)})
    GROUP BY path, label`;
}

export interface FunnelWindowStat {
  views: number;
  direct: number;
  external: number;
  internalIn: number;
  sources: Array<{ kind: string; host: string; views: number }>;
  fromPaths: Array<{ path: string; views: number }>;
  onward: Array<{ path: string; views: number }>;
  ctas: Array<{ label: string; count: number }>;
  leaves: number;
  engagedOver10s: number;
  avgEngagedS: number;
}

export interface FunnelReport {
  pages: Array<{ site: string; path: string; today: FunnelWindowStat; week: FunnelWindowStat }>;
  /** playground cta events at /app, per label — impressions and actions named,
   *  never presented as pageviews */
  playground: { today: Array<{ label: string; count: number }>; week: Array<{ label: string; count: number }> };
}

const emptyWindow = (): FunnelWindowStat => ({
  views: 0, direct: 0, external: 0, internalIn: 0,
  sources: [], fromPaths: [], onward: [], ctas: [],
  leaves: 0, engagedOver10s: 0, avgEngagedS: 0,
});

/** Fold the four query results into per-page stats. Exported for tests. */
export function foldFunnelWindow(
  path: string,
  arrivals: Array<Record<string, unknown>>,
  onward: Array<Record<string, unknown>>,
  leaves: Array<Record<string, unknown>>,
  ctas: Array<Record<string, unknown>>,
): FunnelWindowStat {
  const out = emptyWindow();
  const sources = new Map<string, { kind: string; host: string; views: number }>();
  const fromPaths = new Map<string, number>();
  for (const row of arrivals) {
    if (str(row.path) !== path) continue;
    const views = num(row.views);
    out.views += views;
    const kind = str(row.kind);
    if (kind === 'direct' || kind === '') out.direct += views;
    else if (kind === 'internal') {
      out.internalIn += views;
      const from = str(row.from_path) || '(unknown)';
      fromPaths.set(from, (fromPaths.get(from) ?? 0) + views);
    } else {
      out.external += views;
      const key = `${kind}|${str(row.host)}`;
      const entry = sources.get(key) ?? { kind, host: str(row.host), views: 0 };
      entry.views += views;
      sources.set(key, entry);
    }
  }
  out.sources = [...sources.values()].sort((a, b) => b.views - a.views).slice(0, 8);
  out.fromPaths = [...fromPaths.entries()].map(([p, views]) => ({ path: p, views }))
    .sort((a, b) => b.views - a.views).slice(0, 8);
  out.onward = onward
    .filter((row) => str(row.from_path) === path)
    .map((row) => ({ path: str(row.path), views: num(row.views) }))
    .sort((a, b) => b.views - a.views).slice(0, 8);
  out.ctas = ctas
    .filter((row) => str(row.path) === path)
    .map((row) => ({ label: str(row.label), count: num(row.clicks) }))
    .sort((a, b) => b.count - a.count).slice(0, 8);
  const leaveRow = leaves.find((row) => str(row.path) === path);
  if (leaveRow) {
    out.leaves = num(leaveRow.leaves);
    out.engagedOver10s = num(leaveRow.engaged10);
    out.avgEngagedS = Math.round(num(leaveRow.avg_engaged_ms) / 100) / 10;
  }
  return out;
}

const playgroundLabels = (rows: Array<Record<string, unknown>>): Array<{ label: string; count: number }> =>
  rows
    .filter((row) => str(row.path) === PLAYGROUND_PATH)
    .map((row) => ({ label: str(row.label), count: num(row.clicks) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

export async function readWebFunnel(): Promise<FunnelReport> {
  const { dataset } = settings();
  const site = 'app';
  const paths = FUNNEL_PAGES.map((p) => p.path);
  const ctaPaths = [...paths, PLAYGROUND_PATH];
  const windows: Array<'today' | number> = ['today', 7];
  const [today, week] = await Promise.all(windows.map(async (window) => {
    const [arrivals, onward, leaves, ctas] = await Promise.all([
      query(funnelArrivalsSql(dataset, site, paths, window)),
      query(funnelOnwardSql(dataset, site, paths, window)),
      query(funnelLeavesSql(dataset, site, paths, window)),
      query(funnelCtaSql(dataset, site, ctaPaths, window)),
    ]);
    return { arrivals, onward, leaves, ctas };
  }));
  return {
    pages: FUNNEL_PAGES.map((page) => ({
      site: page.site,
      path: page.path,
      today: foldFunnelWindow(page.path, today.arrivals, today.onward, today.leaves, today.ctas),
      week: foldFunnelWindow(page.path, week.arrivals, week.onward, week.leaves, week.ctas),
    })),
    playground: { today: playgroundLabels(today.ctas), week: playgroundLabels(week.ctas) },
  };
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
