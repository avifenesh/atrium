// tiyuvta inference console — the operator view.
//
// Reads the console's owner API and renders the state that used to be a page on the
// public-facing Worker: accounts, credit, the books, promo seats, webhook failures,
// invoice requests and site traffic. The actions that go with it are POST
// /api/tiyuvta/:action, driven from the panel.
//
// Flags are chosen by what actually needs a human: books out of balance and webhook
// failures are money problems and page; an unenrolled account cannot mint a key, which
// is a customer sitting in a broken state, so it warns.

import { readApiSurfaces, readCreditRequests, readDashboard, readGads, readTraffic, readWebhookFailures, TiyuvtaUnconfigured } from '../core/tiyuvta.js';
import type { GadsReport } from '../core/tiyuvta.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { ExtraRow, Flag } from '../../../shared/types.js';
import type { Collector } from './registry.js';

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
const count = (n: number): string => n.toLocaleString('en-US');

// The ads account spends in ILS; the kill gate is in USD. ECB publishes one rate
// a day, so a 12-hour cache is honest — and a fetch failure keeps the last rate
// rather than dropping the ads rows, because a stale-by-a-day rate misstates
// $/payer by less than hiding the spend does.
const fxCache = new Map<string, { rate: number; at: number }>();
async function usdRate(currency: string): Promise<number | null> {
  if (currency === 'USD') return 1;
  const cached = fxCache.get(currency);
  if (cached && Date.now() - cached.at < 12 * 3_600_000) return cached.rate;
  try {
    const response = await fetch(`https://api.frankfurter.app/latest?from=${currency}&to=USD`, {
      signal: AbortSignal.timeout(10_000),
    });
    const rate = ((await response.json()) as { rates?: { USD?: number } }).rates?.USD;
    if (typeof rate === 'number' && rate > 0) {
      fxCache.set(currency, { rate, at: Date.now() });
      return rate;
    }
  } catch {
    /* fall through to the stale rate */
  }
  return cached?.rate ?? null;
}

/** The ads cell's kill gate (spec/gtm/ADS-PPC-CELL-20260822.md): >$150/payer, or $150 spent with none. */
const KILL_GATE_USD_PER_PAYER = 150;

const collector: Collector = {
  name: 'tiyuvta',
  intervalMs: 5 * 60_000,

  async run() {
    const rows: ExtraRow[] = [];
    const flags: Flag[] = [];
    const now = iso();

    try {
      // One dashboard call carries accounts, money, books, promo and the top accounts;
      // the other three are small and independent, so a failure in any one of them
      // must not cost the dashboard.
      const dashboard = await readDashboard();
      const [traffic, webhooks, invoices, api, gads] = await Promise.all([
        readTraffic(7).catch(() => null),
        readWebhookFailures().catch(() => null),
        readCreditRequests().catch(() => null),
        readApiSurfaces().catch(() => null),
        readGads(30).catch(() => null),
      ]);

      const { accounts, money: m, books, promo, totals } = dashboard;
      const unenrolled = accounts.total - accounts.enrolled;
      const hitRate = totals.promptTokens > 0 ? (totals.cachedPromptTokens / totals.promptTokens) * 100 : 0;

      rows.push(
        { label: 'accounts', value: `${count(accounts.total)} · ${count(accounts.withPurchase)} paying · ${count(accounts.newToday)} today`, href: 'https://inference.tiyuvta.ai/app/admin' },
        { label: 'outstanding credit', value: `${money(m.outstandingMicro)} of ${money(m.creditedMicro)} credited` },
        { label: 'purchased / granted', value: `${money(m.purchasedMicro)} / ${money(m.grantedMicro)}` },
        {
          label: 'spent',
          // totals is customer traffic only; the owner's own bench/smoke accounts
          // report under dashboard.internal so usage stops overstating traction.
          value: `${money(m.spentMicro)} · ${count(totals.requests)} customer requests${
            dashboard.internal?.totals.requests ? ` · ${count(dashboard.internal.totals.requests)} internal` : ''
          }`,
        },
        { label: 'cache hit rate', value: `${hitRate.toFixed(1)}% of input tokens`, tone: hitRate >= 50 ? 'ok' : undefined },
        { label: 'promo seats', value: `${count(promo.claimed)}/${count(promo.seats)} claimed · ${count(promo.remaining)} left`, tone: promo.remaining <= 5 ? 'warn' : undefined },
        {
          label: 'books',
          value: books.outOfBalance === 0 ? 'balanced' : `${count(books.outOfBalance)} account(s) out of balance`,
          tone: books.outOfBalance === 0 ? 'ok' : 'err',
        },
      );

      if (unenrolled > 0) {
        rows.push({ label: 'not enrolled', value: `${count(unenrolled)} account(s) cannot mint a key`, tone: 'err' });
      }
      if (accounts.suspended > 0) {
        rows.push({ label: 'suspended', value: count(accounts.suspended), tone: 'warn' });
      }
      if (m.pendingPurchases) {
        rows.push({ label: 'pending purchases', value: count(m.pendingPurchases), tone: 'warn' });
      }

      const webhookCount = webhooks?.data?.length ?? null;
      rows.push({
        label: 'webhook failures',
        value: webhookCount === null ? 'unreadable' : webhookCount === 0 ? 'none' : count(webhookCount),
        tone: webhookCount ? 'err' : webhookCount === 0 ? 'ok' : 'warn',
      });

      const invoiceCount = invoices?.data?.length ?? null;
      if (invoiceCount) {
        rows.push({ label: 'invoice requests', value: `${count(invoiceCount)} awaiting payment`, tone: 'warn' });
      }

      // What the box actually serves, which is a different question from what the engine
      // repo has released. This row is how a deploy landing becomes visible without
      // anyone re-testing by hand or asking.
      if (api) {
        const named = (state: string) =>
          api.surfaces.filter((s) => s.state === state).map((s) => s.path.replace('/', ''));
        const live = named('present');
        const missing = named('absent');
        const unknown = named('unknown');
        rows.push({
          label: 'api surfaces',
          value: live.length ? live.join(', ') : unknown.length ? 'unreachable — deploying?' : 'none answering',
          tone: live.length ? 'ok' : 'err',
        });
        if (missing.length) {
          rows.push({ label: '  not served', value: missing.join(', '), tone: 'warn' });
        }
        if (unknown.length) {
          rows.push({ label: '  unknown', value: `${unknown.join(', ')} — 5xx, cannot tell`, tone: 'warn' });
        }
        rows.push({
          label: 'models served',
          value: api.models.length ? api.models.join(', ') : 'catalogue unreadable',
          tone: api.models.length ? undefined : 'warn',
        });
      }

      // Ad spend against the funnel it bought — per ref, with the kill gate
      // computed here instead of remembered. Spend is windowed 30d to match the
      // cell; the funnel counts are all-time (payers never expire off their ref).
      // Spend rows with the USD conversion done ONCE here — the CRM overview
      // reads this from data.gads rather than re-fetching a rate.
      const adsSpendUsd: Array<GadsReport['spend'][number] & { costUsd: number | null }> = [];
      if (gads) {
        const stampAge = gads.updatedAt ? Math.round((Date.now() - gads.updatedAt) / 3_600_000) : null;
        if (gads.spend.length === 0) {
          rows.push({
            label: 'ads spend, 30d',
            value: gads.updatedAt ? 'none recorded' : 'no push from the Ads Script yet',
            tone: gads.updatedAt ? undefined : 'warn',
          });
        }
        for (const ad of gads.spend) {
          const rate = ad.currency ? await usdRate(ad.currency) : 1;
          const usd = rate === null ? null : (ad.costMicros / 1e6) * rate;
          adsSpendUsd.push({ ...ad, costUsd: usd });
          const spent = usd === null ? `${(ad.costMicros / 1e6).toFixed(2)} ${ad.currency} (no fx rate)` : `$${usd.toFixed(2)}`;
          const perPayer = usd !== null && ad.paid > 0 ? ` · $${(usd / ad.paid).toFixed(0)}/payer` : '';
          rows.push({
            label: `ads ${ad.ref}`,
            value: `${spent} · ${count(ad.clicks)} clicks · ${count(ad.signups)} signups · ${count(ad.activated)} active · ${count(ad.paid)} paid${perPayer}`,
            tone: ad.paid > 0 ? 'ok' : undefined,
          });
          const breached = usd !== null && (ad.paid > 0 ? usd / ad.paid > KILL_GATE_USD_PER_PAYER : usd > KILL_GATE_USD_PER_PAYER);
          if (breached) {
            flags.push({
              id: `tiyuvta:ads-kill-gate:${ad.ref}`,
              severity: 'warn',
              title: `${ad.ref} is past the ads kill gate`,
              detail: `$${usd.toFixed(2)} spent (30d) for ${ad.paid} payer(s) — the cell says >$${KILL_GATE_USD_PER_PAYER}/payer means pause it. spec/gtm/ADS-PPC-CELL-20260822.md.`,
              source: 'tiyuvta',
              raisedAt: now,
            });
          }
        }
        if (stampAge !== null && stampAge > 26) {
          // The script runs hourly; a day of silence means the schedule or the
          // token broke, and the spend rows above are quietly going stale.
          flags.push({
            id: 'tiyuvta:ads-push-stale',
            severity: 'warn',
            title: `Ads Script has not pushed for ${stampAge}h`,
            detail: 'check the script history under Tools → Scripts in the Ads account, and the GADS_INGEST_TOKEN secret.',
            source: 'tiyuvta',
            raisedAt: now,
          });
        }
      }

      if (traffic) {
        rows.push({
          label: 'site views, 7d',
          value: traffic.configured
            ? `${count(traffic.totals.views)} across ${traffic.totals.sites} site(s)`
            : 'analytics token not set',
          tone: traffic.configured ? undefined : 'warn',
        });
        for (const source of traffic.sources.slice(0, 4)) {
          const host = String(source.host ?? '') || String(source.kind ?? '');
          rows.push({ label: `  ↳ ${source.kind}`, value: `${host || 'direct'} · ${count(Number(source.views ?? 0))} views` });
        }
      }

      // Money that does not add up, and payments we failed to record, are the two
      // things worth a phone call.
      if (books.outOfBalance > 0) {
        flags.push({
          id: 'tiyuvta:books-out-of-balance',
          severity: 'crit',
          title: `${books.outOfBalance} account(s) out of balance`,
          detail: `credited minus spent disagrees with the engine beyond tolerance. Run the accounting pass, then read /admin/reconciliation.`,
          source: 'tiyuvta',
          raisedAt: now,
        });
      }
      if (webhookCount) {
        flags.push({
          id: 'tiyuvta:webhook-failures',
          severity: 'crit',
          title: `${webhookCount} unresolved webhook failure(s)`,
          detail: 'a payment event was not applied. Every one of these is a customer who paid and may not have been credited.',
          source: 'tiyuvta',
          raisedAt: now,
        });
      }
      if (unenrolled > 0) {
        flags.push({
          id: 'tiyuvta:unenrolled',
          severity: 'warn',
          title: `${unenrolled} account(s) not enrolled with the engine`,
          detail: 'they cannot mint an API key until enrolled. Fix with the enroll action.',
          source: 'tiyuvta',
          raisedAt: now,
        });
      }
      if (invoiceCount) {
        flags.push({
          id: 'tiyuvta:invoice-requests',
          severity: 'info',
          title: `${invoiceCount} invoice request(s) awaiting payment`,
          detail: 'manual credit requests that have not been marked paid.',
          source: 'tiyuvta',
          raisedAt: now,
        });
      }

      store.setExtra('tiyuvta', {
        title: 'tiyuvta',
        updatedAt: now,
        up: true,
        rows,
        error: null,
        data: {
          dashboard,
          traffic,
          api,
          gads: gads ? { ...gads, spend: adsSpendUsd } : null,
          webhookFailures: webhooks?.data ?? null,
          creditRequests: invoices?.data ?? null,
        },
      });
      store.setFlags('tiyuvta', flags);
    } catch (error) {
      const missingToken = error instanceof TiyuvtaUnconfigured;
      store.setExtra('tiyuvta', {
        title: 'tiyuvta',
        updatedAt: now,
        // An absent token is "not set up", not "the service is down": showing the
        // console as down because this machine lacks a credential would be a lie
        // about the product.
        up: missingToken,
        rows: missingToken
          ? [{ label: 'owner token', value: 'not found — see core/tiyuvta.ts', tone: 'warn' }]
          : [],
        error: error instanceof Error ? error.message : String(error),
      });
      store.setFlags('tiyuvta', []);
    }
  },
};

export default collector;
