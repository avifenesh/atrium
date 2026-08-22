// CRM overview — one server-side aggregation of the business numbers the
// collectors already hold (console dashboard, web analytics, endpoint health,
// vast spend), shaped for the public CRM page.
//
// Why aggregate here instead of letting the page read /api/snapshot: the CRM
// host is path-confined to /api/crm/* on purpose — the snapshot carries the
// whole machine (agents, repos, comms). This module copies out ONLY the
// business slice, so widening the CRM's data never means widening its surface.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { burnPerDay } from './collectors/vast.js';
import { config } from './config.js';
import { crm } from './crm.js';
import { store } from './state.js';
import { iso, readJson } from './util.js';
import type { CrmItem, CrmOverview, CrmUsageDay } from '../../shared/types.js';

const DAYS = 7;

// --- exposure snapshot --------------------------------------------------------
//
// The exposure collector writes one date-named JSON per day (GitHub traffic,
// HF downloads, crates). The overview reads the newest one — cached for five
// minutes, since the file changes a handful of times a day.

interface SnapshotShape {
  date?: string;
  repos?: Array<{
    repo?: string;
    stars?: number;
    traffic?: { views14d?: { total?: number; uniques?: number }; clones14d?: { total?: number } };
  }>;
  traffic?: { referrers?: Array<{ referrer?: string; count?: number }> };
  huggingface?: Array<{ id?: string; downloads30d?: number; likes?: number }>;
  crates?: Array<{ name?: string; recentDownloads?: number; version?: string }>;
}

let exposureCache: { at: number; value: CrmOverview['exposure'] } = { at: 0, value: null };

async function exposure(): Promise<CrmOverview['exposure']> {
  if (Date.now() - exposureCache.at < 300_000) return exposureCache.value;
  exposureCache = { at: Date.now(), value: null };
  const dir = (config as unknown as { exposure?: { snapshotDir?: string } }).exposure?.snapshotDir;
  if (!dir) return null;
  let newest: string | undefined;
  try {
    newest = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().pop();
  } catch {
    return null;
  }
  if (!newest) return null;
  const snap = await readJson<SnapshotShape>(join(dir, newest));
  if (!snap) return null;
  exposureCache.value = {
    date: snap.date ?? newest.replace('.json', ''),
    repos: (snap.repos ?? []).map((r) => ({
      repo: r.repo ?? '?',
      stars: r.stars ?? 0,
      views14d: r.traffic?.views14d?.total ?? 0,
      uniques14d: r.traffic?.views14d?.uniques ?? 0,
      clones14d: r.traffic?.clones14d?.total ?? 0,
    })),
    referrers: (snap.traffic?.referrers ?? [])
      .filter((r): r is { referrer: string; count: number } => !!r.referrer && typeof r.count === 'number')
      .slice(0, 6),
    huggingface: (snap.huggingface ?? []).map((h) => ({
      id: h.id ?? '?',
      downloads30d: h.downloads30d ?? 0,
      likes: h.likes ?? 0,
    })),
    crates: (snap.crates ?? []).map((c) => ({
      name: c.name ?? '?',
      recentDownloads: c.recentDownloads ?? 0,
      version: c.version ?? '?',
    })),
  };
  return exposureCache.value;
}

interface DashboardShape {
  accounts?: { total?: number; withPurchase?: number; suspended?: number; internal?: number; new7d?: number };
  money?: { purchasedMicro?: number; grantedMicro?: number; spentMicro?: number; outstandingMicro?: number; purchases?: number };
  usage?: Array<Partial<CrmUsageDay>>;
  internal?: { usage?: Array<Partial<CrmUsageDay>> };
}

function usageDays(rows: Array<Partial<CrmUsageDay>> | undefined): CrmUsageDay[] {
  return (rows ?? [])
    .filter((r): r is CrmUsageDay & { day: string } => typeof r.day === 'string')
    .slice(0, DAYS)
    .map((r) => ({
      day: r.day,
      requests: r.requests ?? 0,
      promptTokens: r.promptTokens ?? 0,
      cachedPromptTokens: r.cachedPromptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      debitedMicro: r.debitedMicro ?? 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Post-draft stages, in "did the outreach work" order. */
const REPLIED_STAGES = new Set(['replied', 'signed-up', 'active', 'paying']);

/**
 * Did our outreach do anything? Counts leads AND accounts.
 *
 * Accounts were excluded at first, on the assumption that outreach means cold
 * contact and an account is already past that. That hid the highest-value touch
 * we make: writing to a live user to ask why they stalled. Those emails simply
 * did not appear in the funnel, so the numbers said we had contacted nobody who
 * matters. An account is `contacted` when a touch is logged against it, and
 * `replied` only on its own derived merit (active/paying), never because we
 * pinned a stage by hand.
 */
function outboundFunnel(items: CrmItem[]): CrmOverview['outbound'] {
  const bySource = new Map<string, { source: string; drafted: number; contacted: number; replied: number }>();
  const totals = { drafted: 0, contacted: 0, replied: 0, bySource: [] as CrmOverview['outbound']['bySource'] };
  for (const item of items) {
    if (item.kind !== 'lead' && item.kind !== 'account') continue;
    const drafted = item.notes.some((n) => n.text.startsWith('outreach draft'));
    // "contacted" = ANY outreach happened: the owner's own posted reply
    // (self-comment auto-mark), a logged touch, or a manual stage move. The
    // first cut only counted seller-drafted leads, which erased the owner's
    // real activity — most outreach is his own comments, not drafts.
    // On an account a logged touch is the only honest signal: its stage is
    // derived from console usage and would otherwise count every active user
    // as "contacted" without anyone having written a word.
    const contacted = item.kind === 'account'
      ? item.contacts.length > 0
      : item.contacts.length > 0 || (item.stage !== 'new' && item.stage !== 'lost');
    // An account being `active` says nothing about our email: it was active
    // before we wrote. Derived stages never yield 'replied', so on an account
    // that value can only come from the owner pinning it after a real answer
    // arrived — which is the only evidence of a reply this store holds.
    const replied = item.kind === 'account'
      ? item.stage === 'replied'
      : REPLIED_STAGES.has(item.stage);
    if (!drafted && !contacted) continue;
    const key = item.source ?? '?';
    const row = bySource.get(key) ?? { source: key, drafted: 0, contacted: 0, replied: 0 };
    if (drafted) {
      row.drafted += 1;
      totals.drafted += 1;
    }
    if (contacted) {
      row.contacted += 1;
      totals.contacted += 1;
    }
    if (replied) {
      row.replied += 1;
      totals.replied += 1;
    }
    bySource.set(key, row);
  }
  totals.bySource = [...bySource.values()].sort((a, b) => b.contacted - a.contacted || b.drafted - a.drafted);
  return totals;
}

function pnl(days: CrmUsageDay[]): CrmOverview['pnl'] {
  const burn = burnPerDay();
  return days
    .filter((d) => burn[d.day] != null)
    .map((d) => {
      const revenueUsd = d.debitedMicro / 1_000_000;
      const burnUsd = burn[d.day] * 24;
      return { day: d.day, revenueUsd, burnUsd, netUsd: revenueUsd - burnUsd };
    });
}

export async function crmOverview(): Promise<CrmOverview> {
  const extra = store.get().extra;

  const tiyuvta = extra['tiyuvta']?.data as
    | {
        dashboard?: DashboardShape;
        api?: { models?: string[] };
        gads?: {
          updatedAt: number | null;
          spend: Array<{
            ref: string;
            costUsd?: number | null;
            clicks: number;
            signups: number;
            activated: number;
            paid: number;
          }>;
        } | null;
      }
    | undefined;
  const dashboard = tiyuvta?.dashboard;

  const web = extra['webtraffic']?.data as CrmOverview['visitors'] | undefined;
  const endpoint = extra['endpoint']?.data as
    | (NonNullable<CrmOverview['endpoint']> & { probesPerDay?: Record<string, number> })
    | undefined;
  const vast = extra['vast']?.data as
    | {
        burnPerHour?: number;
        creditUsd?: number | null;
        instances?: Array<{
          label?: string | null;
          gpuName?: string | null;
          numGpus?: number | null;
          dphTotal?: number | null;
          status?: string | null;
        }>;
      }
    | undefined;

  return {
    updatedAt: iso(),
    money: dashboard?.money
      ? {
          purchasedMicro: dashboard.money.purchasedMicro ?? 0,
          grantedMicro: dashboard.money.grantedMicro ?? 0,
          spentMicro: dashboard.money.spentMicro ?? 0,
          outstandingMicro: dashboard.money.outstandingMicro ?? 0,
          purchases: dashboard.money.purchases ?? 0,
        }
      : null,
    accounts: dashboard?.accounts
      ? {
          total: dashboard.accounts.total ?? 0,
          withPurchase: dashboard.accounts.withPurchase ?? 0,
          suspended: dashboard.accounts.suspended ?? 0,
          internal: dashboard.accounts.internal ?? 0,
          newWeek: dashboard.accounts.new7d ?? 0,
        }
      : null,
    pnl: pnl(usageDays(dashboard?.usage)),
    outbound: outboundFunnel(crm.pipeline().items),
    usageDays: usageDays(dashboard?.usage),
    // internal traffic minus the endpoint collector's own 5-minute TTFT probes —
    // ~576 requests/day of synthetic pings would otherwise drown the number that
    // is supposed to mean "the owner's real bench/test usage"
    internalDays: usageDays(dashboard?.internal?.usage).map((row) => ({
      ...row,
      requests: Math.max(0, row.requests - (endpoint?.probesPerDay?.[row.day] ?? 0)),
    })),
    visitors: web && Array.isArray(web.daily)
      ? {
          totals: web.totals ?? [],
          daily: web.daily,
          topPaths: (web.topPaths ?? []).slice(0, 10),
          referrers: (web.referrers ?? []).slice(0, 15),
          channels: (web.channels ?? []).slice(0, 10),
        }
      : null,
    endpoint: endpoint && Array.isArray(endpoint.models)
      ? { models: endpoint.models, series: Array.isArray(endpoint.series) ? endpoint.series : [] }
      : null,
    expenses: vast
      ? {
          burnPerHour: vast.burnPerHour ?? 0,
          creditUsd: vast.creditUsd ?? null,
          instances: (vast.instances ?? []).map((i) => ({
            label: i.label ?? null,
            gpuName: i.gpuName ?? null,
            numGpus: i.numGpus ?? null,
            dphTotal: i.dphTotal ?? null,
            status: i.status ?? null,
          })),
        }
      : null,
    realUsage: (() => {
      const metrics = extra['apimetrics']?.data as { models?: CrmOverview['realUsage'] } | undefined;
      return metrics?.models ?? null;
    })(),
    realUsageHourly: (() => {
      const metrics = extra['apimetrics']?.data as { hourly?: CrmOverview['realUsageHourly'] } | undefined;
      return metrics?.hourly ?? null;
    })(),
    competitors: (() => {
      const or = extra['openrouter']?.data as { models?: CrmOverview['competitors'] } | undefined;
      return or?.models ?? null;
    })(),
    signupSources: (() => {
      const counts = new Map<string, number>();
      for (const account of dashboard && Array.isArray((dashboard as { top?: unknown }).top)
        ? ((dashboard as unknown as { top: Array<{ signupRef?: string | null; internal?: boolean }> }).top)
        : []) {
        if (account.internal) continue;
        const key = account.signupRef ?? 'organic';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
    })(),
    ads: tiyuvta?.gads
      ? {
          updatedAt: tiyuvta.gads.updatedAt,
          rows: tiyuvta.gads.spend.map((s) => ({
            ref: s.ref,
            costUsd: s.costUsd ?? null,
            clicks: s.clicks,
            signups: s.signups,
            activated: s.activated,
            paid: s.paid,
          })),
        }
      : null,
    exposure: await exposure(),
    models: tiyuvta?.api?.models ?? [],
  };
}
