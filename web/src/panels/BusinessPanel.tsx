import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import Spark from '../components/Spark';
import { EmptyState, Panel, RelTime, Row } from '../components/ui';
import { CounterRow, DemandRow, LeadButtons, MentionRow } from './SignalsPanel';
import type { SignalItem, Snapshot } from '../../../shared/types';

/** The business board — tiyuvta inference in one glance.
 *  Money/ops up top (accounts, credit, spend, failures), the lead queue on the left
 *  (mentions + demand threads worth going to comment on), the funnel on the right
 *  (site behaviour, download/star trends, live API surfaces). Detail lives in the
 *  tiyuvta / webtraffic / signals views; this is the morning read. */

// minimal local shapes for the extra-lane payloads (typed fully in server/src/core)
interface TiyuvtaData {
  dashboard: {
    accounts: { total: number; enrolled: number; suspended: number; newToday: number; new7d: number };
    money: { purchasedMicro: number; spentMicro: number; outstandingMicro: number };
    totals: { requests: number; cachedPromptTokens: number; promptTokens: number };
    promo: { claimed: number; seats: number; remaining: number };
    books: { outOfBalance: number };
  } | null;
  api: { surfaces: Array<{ path: string; state: string }>; models: string[] } | null;
  webhookFailures: unknown[] | null;
  creditRequests: unknown[] | null;
}

interface WebTrafficData {
  days: number;
  totals: Array<{ site: string; views: number }>;
  daily: Array<{ day: string; site: string; views: number }>;
  channels: Array<{ channel: string; views: number; prevViews: number; delta: number }>;
}

const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro >= 100e6 ? 0 : 2)}`;

function Stat({
  value,
  label,
  tone,
  onClick,
}: {
  value: string;
  label: string;
  tone?: 'amber' | 'jade' | 'coral';
  onClick?: () => void;
}) {
  const cls =
    tone === 'coral' ? 'text-coral' : tone === 'amber' ? 'text-amber' : tone === 'jade' ? 'text-jade' : 'text-mist';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-w-[6rem] flex-col items-start px-2 py-1 text-left ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <span className={`font-display text-4xl italic leading-none tracking-[-0.04em] xl:text-5xl ${cls}`}>{value}</span>
      <span className="mt-2 text-xs font-medium text-mist-faint transition-colors group-hover:text-mist-dim">{label}</span>
    </button>
  );
}

export default function BusinessPanel({
  snapshot,
  onNavigate,
}: {
  snapshot: Snapshot;
  onNavigate: (viewId: string, focus?: string | null) => void;
}) {
  const tiyuvta = (snapshot.extra?.tiyuvta?.data ?? null) as TiyuvtaData | null;
  const traffic = (snapshot.extra?.webtraffic?.data ?? null) as WebTrafficData | null;
  const sig = snapshot.signals;

  const reviewedAt = sig.lastReviewedAt;
  const isNew = (s: SignalItem) => !reviewedAt || s.firstSeenAt > reviewedAt;

  // the lead queue: untouched mentions + demand threads, hottest and newest first
  const leads = useMemo(() => {
    return sig.items
      .filter((s) => (s.kind === 'mention' || s.kind === 'demand-thread') && !s.lead)
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.occurredAt ?? b.firstSeenAt).localeCompare(a.occurredAt ?? a.firstSeenAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig.items]);

  const trendCounters = sig.items.filter((s) => s.kind === 'counter' && s.spark && s.spark.length >= 2);

  // per-site daily series for the sparkline, zero-padded over the window's days
  const siteSeries = useMemo(() => {
    if (!traffic) return [];
    const days = [...new Set(traffic.daily.map((d) => d.day))].sort();
    return traffic.totals.map((t) => ({
      site: t.site,
      views: t.views,
      series: days.map((day) => traffic.daily.find((d) => d.day === day && d.site === t.site)?.views ?? 0),
    }));
  }, [traffic]);

  const dash = tiyuvta?.dashboard ?? null;
  const webhookFailures = tiyuvta?.webhookFailures?.length ?? 0;
  const invoiceRequests = tiyuvta?.creditRequests?.length ?? 0;
  const cacheHit = dash && dash.totals.promptTokens > 0
    ? Math.round((dash.totals.cachedPromptTokens / dash.totals.promptTokens) * 100)
    : null;
  const liveSurfaces = tiyuvta?.api?.surfaces.filter((s) => s.state === 'present') ?? [];

  return (
    <div className="grid grid-cols-12 gap-5">
      {/* money/ops strip — the numbers the business runs on */}
      <section
        className="stat-band rise col-span-12 flex flex-wrap items-end gap-x-8 gap-y-4 px-6 py-6 lg:gap-x-12"
        style={{ '--rise-i': 0 } as CSSProperties}
      >
        {dash ? (
          <>
            <Stat value={usd(dash.money.outstandingMicro)} label="Credit outstanding" onClick={() => onNavigate('tiyuvta')} />
            <Stat value={usd(dash.money.spentMicro)} label="Spend metered" onClick={() => onNavigate('tiyuvta')} />
            <Stat value={String(dash.totals.requests)} label="Requests" onClick={() => onNavigate('tiyuvta')} />
            <Stat
              value={`${dash.accounts.total}`}
              label={`Accounts · +${dash.accounts.new7d} this week`}
              tone={dash.accounts.newToday > 0 ? 'jade' : undefined}
              onClick={() => onNavigate('tiyuvta')}
            />
            {cacheHit !== null && <Stat value={`${cacheHit}%`} label="Cache hit" onClick={() => onNavigate('tiyuvta')} />}
            {dash.books.outOfBalance > 0 && (
              <Stat value={String(dash.books.outOfBalance)} label="Books out of balance" tone="coral" onClick={() => onNavigate('tiyuvta')} />
            )}
            {webhookFailures > 0 && (
              <Stat value={String(webhookFailures)} label="Webhook failures" tone="coral" onClick={() => onNavigate('tiyuvta')} />
            )}
            {invoiceRequests > 0 && (
              <Stat value={String(invoiceRequests)} label="Invoice requests" tone="amber" onClick={() => onNavigate('tiyuvta')} />
            )}
          </>
        ) : (
          <div className="text-sm text-mist-faint">
            tiyuvta console not reporting — <button type="button" onClick={() => onNavigate('tiyuvta')} className="cursor-pointer underline">open the ops view</button>
          </div>
        )}
      </section>

      {/* lead queue — where to go comment next */}
      <div className="col-span-12 flex flex-col gap-5 lg:col-span-7">
        <Panel
          title="Lead queue"
          riseIndex={1}
          right={
            <span className="flex items-baseline gap-3">
              <span className="font-mono text-xs tabular-nums text-mist-faint">{leads.length}</span>
              <button
                type="button"
                onClick={() => onNavigate('signals')}
                className="cursor-pointer font-mono text-[11px] text-mist-faint hover:text-mist"
              >
                all signals
              </button>
            </span>
          }
        >
          {leads.length === 0 ? (
            <EmptyState>Queue clear — every lead is engaged or skipped.</EmptyState>
          ) : (
            <div className="max-h-[30rem] space-y-0.5 overflow-y-auto">
              {leads.slice(0, 15).map((s) =>
                s.kind === 'mention' ? (
                  <MentionRow key={s.id} s={s} isNew={isNew(s)} />
                ) : (
                  <DemandRow key={s.id} s={s} isNew={isNew(s)} />
                ),
              )}
            </div>
          )}
        </Panel>

        <Panel title="Reach trends" riseIndex={3}>
          {trendCounters.length === 0 ? (
            <EmptyState>No counter history yet — trends appear after a few daily snapshots.</EmptyState>
          ) : (
            <div className="max-h-[22rem] space-y-0.5 overflow-y-auto">
              {trendCounters.map((s) => (
                <CounterRow key={s.id} s={s} />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* funnel + serving state */}
      <div className="col-span-12 flex flex-col gap-5 lg:col-span-5">
        <Panel
          title="Site behaviour"
          riseIndex={2}
          right={
            <button
              type="button"
              onClick={() => onNavigate('webtraffic')}
              className="cursor-pointer font-mono text-[11px] text-mist-faint hover:text-mist"
            >
              detail
            </button>
          }
        >
          {!traffic ? (
            <EmptyState>Web traffic not reporting.</EmptyState>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2">
                {siteSeries.map((s) => (
                  <div key={s.site} className="glass rounded-lg px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-[11px] text-mist-faint">{s.site}</span>
                      <span className="font-mono text-sm tabular-nums text-mist">{s.views}</span>
                    </div>
                    <div className="mt-1">
                      <Spark series={s.series} className="text-mist-dim" />
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-mist-faint">views · {traffic.days}d</div>
                  </div>
                ))}
              </div>
              <div className="space-y-0.5">
                {traffic.channels.slice(0, 6).map((c) => (
                  <Row key={c.channel} className="py-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-mist-dim">{c.channel}</span>
                    <span className="shrink-0 font-mono text-sm tabular-nums text-mist">{c.views}</span>
                    {c.delta !== 0 && (
                      <span className={`shrink-0 font-mono text-xs tabular-nums ${c.delta > 0 ? 'text-jade' : 'text-coral'}`}>
                        {c.delta > 0 ? `+${c.delta}` : c.delta}
                      </span>
                    )}
                  </Row>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel title="Serving" riseIndex={4}>
          {!tiyuvta?.api ? (
            <EmptyState>API surface probe not reporting.</EmptyState>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap gap-1.5 px-2.5">
                {tiyuvta.api.surfaces.map((s) => (
                  <span
                    key={s.path}
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                      s.state === 'present' ? 'bg-jade/10 text-jade' : 'bg-white/5 text-mist-faint'
                    }`}
                  >
                    {s.path}
                  </span>
                ))}
              </div>
              <div className="px-2.5 pb-1 font-mono text-[11px] text-mist-dim">
                {liveSurfaces.length} live surface{liveSurfaces.length === 1 ? '' : 's'}
                {tiyuvta.api.models.length > 0 && ` · serving ${tiyuvta.api.models.join(', ')}`}
              </div>
            </>
          )}
        </Panel>

        <Panel title="Updated" riseIndex={5}>
          <Row className="justify-between py-1.5 font-mono text-[11px] text-mist-faint">
            <span>tiyuvta</span>
            <RelTime iso={snapshot.extra?.tiyuvta?.updatedAt ?? null} />
          </Row>
          <Row className="justify-between py-1.5 font-mono text-[11px] text-mist-faint">
            <span>webtraffic</span>
            <RelTime iso={snapshot.extra?.webtraffic?.updatedAt ?? null} />
          </Row>
          <Row className="justify-between py-1.5 font-mono text-[11px] text-mist-faint">
            <span>signals</span>
            <RelTime iso={sig.updatedAt} />
          </Row>
        </Panel>
      </div>
    </div>
  );
}
