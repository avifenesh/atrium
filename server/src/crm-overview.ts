// CRM overview — one server-side aggregation of the business numbers the
// collectors already hold (console dashboard, web analytics, endpoint health,
// vast spend), shaped for the public CRM page.
//
// Why aggregate here instead of letting the page read /api/snapshot: the CRM
// host is path-confined to /api/crm/* on purpose — the snapshot carries the
// whole machine (agents, repos, comms). This module copies out ONLY the
// business slice, so widening the CRM's data never means widening its surface.

import { store } from './state.js';
import { iso } from './util.js';
import type { CrmOverview, CrmUsageDay } from '../../shared/types.js';

const DAYS = 7;

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
      completionTokens: r.completionTokens ?? 0,
      debitedMicro: r.debitedMicro ?? 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export function crmOverview(): CrmOverview {
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
    models: tiyuvta?.api?.models ?? [],
  };
}
