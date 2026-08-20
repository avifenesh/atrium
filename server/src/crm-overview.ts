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
import { config } from './config.js';
import { store } from './state.js';
import { iso, readJson } from './util.js';
import type { CrmOverview, CrmUsageDay } from '../../shared/types.js';

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

export async function crmOverview(): Promise<CrmOverview> {
  const extra = store.get().extra;

  const tiyuvta = extra['tiyuvta']?.data as { dashboard?: DashboardShape; api?: { models?: string[] } } | undefined;
  const dashboard = tiyuvta?.dashboard;

  const web = extra['webtraffic']?.data as CrmOverview['visitors'] | undefined;
  const endpoint = extra['endpoint']?.data as CrmOverview['endpoint'] | undefined;
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
    usageDays: usageDays(dashboard?.usage),
    internalDays: usageDays(dashboard?.internal?.usage),
    visitors: web && Array.isArray(web.daily)
      ? { totals: web.totals ?? [], daily: web.daily, topPaths: (web.topPaths ?? []).slice(0, 10) }
      : null,
    endpoint: endpoint && Array.isArray(endpoint.models) ? { models: endpoint.models } : null,
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
    exposure: await exposure(),
    models: tiyuvta?.api?.models ?? [],
  };
}
