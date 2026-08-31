// Business overview, split across the CRM's tabs. The pipeline tab keeps only a
// one-line pulse strip; the numbers moved to Money / Growth / Health so each
// screen answers one question instead of all of them at once.
//
// Chart color law (validated against ink surfaces, 2026-08-22): at most two
// series per chart. jade+coral (revenue vs burn) sit in the CVD floor band and
// are therefore ALWAYS separated by mark kind too (bars vs line); slate-glow
// pairs with mist for same-kind series. Amber stays reserved for attention.

import { useState } from 'react';
import type { CrmFunnelWindow, CrmOverview, CrmUsageDay } from '../../../shared/types';
import { BarList, TrendChart } from './charts';

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const usd0 = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(0)}`;
const sum = (days: CrmUsageDay[], pick: (d: CrmUsageDay) => number) => days.reduce((a, d) => a + pick(d), 0);

const JADE = 'var(--color-jade)';
const CORAL = 'var(--color-coral)';
const SLATE = 'var(--color-slate-glow)';
const MIST = 'var(--color-mist)';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">{label}</div>
      <div className={`mt-1 text-lg leading-none ${tone ?? 'text-mist'}`}>{value}</div>
      {sub && <div className="mt-1 font-mono text-[10px] text-mist-dim">{sub}</div>}
    </div>
  );
}

function Chip({ children, tone = 'border-white/10 text-mist-dim' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`rounded-full border px-2.5 py-1 font-mono text-[10px] ${tone}`}>{children}</span>;
}

// --- pipeline tab: the pulse strip -------------------------------------------

export function PulseStrip({ data, dueCount }: { data: CrmOverview; dueCount: number }) {
  const { pnl, usageDays, visitors, endpoint, accounts, ads, serving } = data;
  const pnlToday = pnl[pnl.length - 1] ?? null;
  const revenue7d = sum(usageDays, (d) => d.debitedMicro);
  const visitors7d = visitors ? visitors.totals.reduce((a, t) => a + t.views, 0) : null;
  const down = (endpoint?.models ?? []).filter((m) => !m.ok);
  const killGate = (ads?.rows ?? []).some(
    (a) => a.costUsd != null && (a.paid > 0 ? a.costUsd / a.paid > 150 : a.costUsd > 150),
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip tone={pnlToday && pnlToday.netUsd >= 0 ? 'border-jade/30 text-jade' : 'border-white/10 text-mist-dim'}>
        p&l {pnlToday ? `${usd0(pnlToday.netUsd)}/day` : '—'}
      </Chip>
      <Chip>rev 7d {usd(revenue7d)}</Chip>
      <Chip>visitors 7d {visitors7d ?? '—'}</Chip>
      {accounts && <Chip>{accounts.total} accounts · {accounts.withPurchase} paying</Chip>}
      {down.length > 0 && (
        <Chip tone="border-coral/50 text-coral">{down.map((m) => m.model.split('/').pop()).join(', ')} DOWN</Chip>
      )}
      {killGate && <Chip tone="border-amber/40 text-amber">ads KILL GATE</Chip>}
      {dueCount > 0 && <Chip tone="border-amber/40 text-amber">⏰ {dueCount} due</Chip>}
      {/* Serving watchdog, on the pipeline screen too: an open crit on a box that takes
          money outranks every follow-up on this page, so it must not live only one tab
          away. A dead sentinel is its own chip — a silent pager and a healthy fleet look
          identical from here otherwise. */}
      {serving && serving.tickAgeS === null && (
        <Chip tone="border-coral/50 text-coral">sentinel NOT RUNNING</Chip>
      )}
      {serving && serving.tickAgeS !== null && serving.tickAgeS > 600 && (
        <Chip tone="border-coral/50 text-coral">sentinel stalled {Math.round(serving.tickAgeS / 60)}m</Chip>
      )}
      {serving && serving.openCrit > 0 && (
        <Chip tone="border-coral/50 text-coral">serving {serving.openCrit} CRIT</Chip>
      )}
      {serving && serving.openCrit === 0 && serving.openWarn > 0 && (
        <Chip tone="border-amber/40 text-amber">serving {serving.openWarn} warn</Chip>
      )}
    </div>
  );
}

// --- serving watchdog ---------------------------------------------------------
//
// Read-only by construction: there is no acknowledge button, no silence button and no
// revive button. atrium keeps action names on an allowlist rather than proxying paths
// precisely so that a page can never become a remote control over a serving box.

function IncidentRow({ inc }: { inc: NonNullable<CrmOverview['serving']>['incidents'][number] }) {
  const tone = !inc.open
    ? 'border-white/8 text-mist-dim'
    : inc.severity === 'crit'
      ? 'border-coral/40 text-coral'
      : inc.severity === 'warn'
        ? 'border-amber/30 text-amber'
        : 'border-white/10 text-mist-dim';
  return (
    <div className={`rounded-xl border bg-ink-2 px-3.5 py-2.5 ${tone}`}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider">
          {inc.open ? inc.severity : 'cleared'}
        </span>
        <span className="min-w-0 flex-1 text-sm text-mist">{inc.title}</span>
        {/* the ladder's rung count is the incident's age in pages — the number that says
            "this is the same outage, not seventeen of them" */}
        {inc.pages > 1 && (
          <span className="shrink-0 font-mono text-[10px] text-mist-dim">×{inc.pages}</span>
        )}
      </div>
      <div className="mt-1 font-mono text-[10px] leading-relaxed text-mist-dim">{inc.detail}</div>
      <div className="mt-1 font-mono text-[10px] text-mist-faint">
        {inc.scope} · {inc.kind} · since {inc.firstAt.slice(5, 16).replace('T', ' ')}
        {inc.open ? ` · last ${inc.lastAt.slice(11, 16)}` : ` · cleared ${inc.resolvedAt?.slice(11, 16) ?? ''}`}
        {!inc.open && inc.clearedBy ? ` — ${inc.clearedBy}` : ''}
      </div>
    </div>
  );
}

export function ServingBlock({ serving }: { serving: CrmOverview['serving'] }) {
  if (!serving) return null;
  const open = serving.incidents.filter((i) => i.open);
  const recent = serving.incidents.filter((i) => !i.open).slice(0, 6);
  // The sentinel's heartbeat is load-bearing, not decoration: with no tick, this whole
  // block is quiet for the same reason a healthy fleet is quiet.
  const stale = serving.tickAgeS === null || serving.tickAgeS > 600;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={stale ? 'border-coral/50 text-coral' : 'border-jade/30 text-jade'}>
          watchdog{' '}
          {serving.tickAgeS === null
            ? 'NOT RUNNING — the boxes are unwatched'
            : stale
              ? `STALLED · last tick ${Math.round(serving.tickAgeS / 60)}m ago`
              : `ticking · ${serving.tickAgeS}s ago`}
        </Chip>
        {open.length === 0 && !stale && (
          <Chip tone="border-jade/30 text-jade">no open serving incidents</Chip>
        )}
      </div>
      {open.length > 0 && (
        <div className="space-y-1.5">
          {open.map((i) => (
            <IncidentRow key={i.key} inc={i} />
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">
            recently cleared
          </div>
          {recent.map((i) => (
            <IncidentRow key={i.key} inc={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- money tab ----------------------------------------------------------------

export function MoneyTab({ data }: { data: CrmOverview }) {
  const { money, usageDays, internalDays, expenses, pnl } = data;
  const revenue7d = sum(usageDays, (d) => d.debitedMicro);
  const requests7d = sum(usageDays, (d) => d.requests);
  const tokens7d = sum(usageDays, (d) => d.promptTokens + d.completionTokens);
  const prompt7d = sum(usageDays, (d) => d.promptTokens);
  const cached7d = sum(usageDays, (d) => d.cachedPromptTokens);
  const today = usageDays[usageDays.length - 1];
  const pnl7d = pnl.reduce((a, d) => a + d.netUsd, 0);
  const burnDay = expenses ? expenses.burnPerHour * 24 : 0;
  // Runway = credit ÷ ON-DEMAND burn only: prepaid boxes were paid up front and
  // do not drain the credit (owner ruling 2026-08-23 — counting them made the
  // runway lie short).
  const marginalDay = expenses ? expenses.marginalPerHour * 24 : 0;
  const runwayDays = expenses?.creditUsd != null && marginalDay > 0 ? expenses.creditUsd / marginalDay : null;

  const days = usageDays.map((d) => d.day);
  const internalByDay = new Map(internalDays.map((d) => [d.day, d.requests]));
  const burnByDay = new Map(pnl.map((d) => [d.day, d.burnUsd]));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="p&l"
          value={pnl[pnl.length - 1] ? `${usd0(pnl[pnl.length - 1].netUsd)}/day` : '—'}
          sub={pnl.length ? `${pnl.length}d net ${usd0(pnl7d)}` : 'burn history warming'}
          tone={pnl[pnl.length - 1] && pnl[pnl.length - 1].netUsd >= 0 ? 'text-jade' : undefined}
        />
        <Stat label="income all-time" value={money ? usd(money.purchasedMicro) : '—'} sub={money ? `${money.purchases} purchase${money.purchases === 1 ? '' : 's'}` : null} />
        <Stat label="usage revenue 7d" value={usd(revenue7d)} sub={today ? `today ${usd(today.debitedMicro)}` : null} />
        <Stat label="outstanding" value={money ? usd(money.outstandingMicro) : '—'} sub={money ? `granted ${usd(money.grantedMicro)}` : null} />
        <Stat
          label="gpu burn"
          value={expenses ? `$${expenses.burnPerHour.toFixed(2)}/hr` : '—'}
          sub={
            expenses
              ? `$${expenses.prepaidPerHour.toFixed(2)} prepaid + $${expenses.marginalPerHour.toFixed(2)} on-demand · ≈$${burnDay.toFixed(0)}/day · credit ${expenses.creditUsd == null ? '?' : `$${expenses.creditUsd.toFixed(0)}`}${runwayDays != null ? ` (~${runwayDays.toFixed(1)}d)` : ''}`
              : null
          }
        />
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <TrendChart
          title="revenue vs gpu burn, $/day"
          labels={days}
          series={[
            { name: 'revenue', color: JADE, kind: 'bar', values: usageDays.map((d) => d.debitedMicro / 1e6) },
            { name: 'burn', color: CORAL, kind: 'line', values: days.map((d) => burnByDay.get(d) ?? null) },
          ]}
          format={(v) => `$${v.toFixed(v < 10 ? 2 : 0)}`}
        />
        <TrendChart
          title={`requests/day · ${(tokens7d / 1e6).toFixed(1)}M tokens 7d`}
          labels={days}
          series={[
            { name: 'customers', color: SLATE, kind: 'bar', values: usageDays.map((d) => d.requests) },
            { name: 'internal', color: MIST, kind: 'line', values: days.map((d) => internalByDay.get(d) ?? 0) },
          ]}
          format={(v) => String(Math.round(v))}
        />
        <TrendChart
          title={`cache hit %, of input tokens · 7d ${prompt7d > 0 ? ((cached7d / prompt7d) * 100).toFixed(1) : '—'}%`}
          labels={days}
          series={[
            {
              name: 'hit %',
              color: SLATE,
              kind: 'line',
              values: usageDays.map((d) => (d.promptTokens > 0 ? (d.cachedPromptTokens / d.promptTokens) * 100 : null)),
            },
          ]}
          format={(v) => `${v.toFixed(0)}%`}
        />
        <Stat
          label="requests 7d"
          value={String(requests7d)}
          sub={`${(cached7d / 1e6).toFixed(1)}M of ${(prompt7d / 1e6).toFixed(1)}M input tokens cached`}
        />
      </div>

      {expenses && expenses.instances.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {expenses.instances.map((i, at) => (
            <Chip key={at}>
              {i.label ?? i.gpuName ?? '?'} · {i.numGpus ?? '?'}× {i.gpuName ?? ''} · ${i.dphTotal?.toFixed(2) ?? '?'}/hr · {i.status ?? '?'}
              {i.prepaid ? ' · prepaid' : ''}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

// --- traffic tab ----------------------------------------------------------------
//
// Who is coming to the sites and from where. The outreach numbers (funnel, ads,
// competitors) moved to their own tab: "is the site being found" and "is our
// selling working" are different questions asked at different moments.

// The conversion funnel for the pages where money enters. Cookieless, so
// "closed without acting" is an aggregate approximation (views − CTA clicks −
// onward navigations), never a per-visitor fact — that trade bought the sites
// their banner-free state and is not up for revision here.

function FunnelWindowRow({ label, w }: { label: string; w: CrmFunnelWindow }) {
  const acted = w.ctas.reduce((a, c) => a + c.count, 0);
  const onward = w.onward.reduce((a, o) => a + o.views, 0);
  // These buckets are NOT a partition of views: one visitor can act AND browse
  // on, reloads/back-nav re-count as views, a double-click is two ctas. So the
  // residue is "unaccounted views" (biased HIGH — re-views land here), never
  // "people who left"; and a negative residue is shown as overlap, not clamped
  // away, because it is the signal the approximation broke.
  const residue = w.views - acted - onward;
  return (
    <div className="rounded-lg border border-white/8 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[12px]">
        <span className="text-mist-faint uppercase text-[10px] tracking-wider">{label}</span>
        <span className="text-mist">{w.views} views</span>
        <span className={acted > 0 ? 'text-jade' : 'text-mist-dim'}>{acted} acted</span>
        <span className="text-mist-dim">{onward} browsed on</span>
        {residue >= 0
          ? <span className={residue > 0 && w.views > 0 ? 'text-amber' : 'text-mist-dim'} title="views minus actions minus onward navigations; reloads and back-nav count as extra views, so this reads HIGH">≈{residue} unaccounted</span>
          : <span className="text-mist-dim" title="more actions+navigations than views: visitors acted and browsed on, or acted twice">overlap</span>}
        {w.leaves > 0 && (
          <span className="text-mist-dim">
            {w.engagedOver10s}/{w.leaves} stayed &gt;10s · avg {w.avgEngagedS}s
          </span>
        )}
      </div>
      {(w.ctas.length > 0 || w.sources.length > 0 || w.fromPaths.length > 0 || w.onward.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-mist-faint">
          {w.ctas.length > 0 && <span>acted: {w.ctas.map((c) => `${c.label} ${c.count}`).join(' · ')}</span>}
          {w.sources.length > 0 && (
            <span>from outside: {w.sources.slice(0, 4).map((s) => `${s.host || s.kind} ${s.views}`).join(' · ')}{w.direct > 0 ? ` · direct ${w.direct}` : ''}</span>
          )}
          {w.sources.length === 0 && w.direct > 0 && <span>direct {w.direct}</span>}
          {w.fromPaths.length > 0 && <span>from our pages: {w.fromPaths.slice(0, 4).map((f) => `${f.path} ${f.views}`).join(' · ')}</span>}
          {w.onward.length > 0 && <span>went to: {w.onward.slice(0, 4).map((o) => `${o.path} ${o.views}`).join(' · ')}</span>}
        </div>
      )}
    </div>
  );
}

const WINDOW_LABEL: Record<string, string> = {
  today: 'today',
  yesterday: 'yesterday',
  '24h': 'last 24h',
  '3d': '3 days',
  '7d': '7 days',
};

export function FunnelBlock({ funnel, win }: { funnel: CrmOverview['funnel']; win: string }) {
  if (!funnel || funnel.pages.length === 0) return null;
  const pg = funnel.playground?.[win] ?? [];
  const pgLine = pg.map((r) => `${r.label.replace(/^playground_/, '')} ${r.count}`).join(' · ');
  return (
    <div className="space-y-2">
      {funnel.pages.map((page) => {
        const stat = page.byWindow[win];
        if (!stat) return null;
        return (
          <div key={`${page.site}:${page.path}`} className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
            <div className="mb-1.5 font-mono text-[11px] text-mist">
              {page.path === '/login' ? 'sign-in page' : page.path}
              <span className="ml-2 text-mist-faint">{page.site} {page.path}</span>
            </div>
            <FunnelWindowRow label={WINDOW_LABEL[win] ?? win} w={stat} />
          </div>
        );
      })}
      {/* The signed-in playground sends only labeled events (the page itself is
          unbeaconed by design), so it gets an event line, never a views funnel.
          `rendered` fires on page render — an impression, not a user action. */}
      {pgLine && (
        <div className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
          <div className="mb-1 font-mono text-[11px] text-mist">
            playground events
            <span className="ml-2 text-mist-faint">app /app · rendered = impression, first_success = first API call</span>
          </div>
          <div className="font-mono text-[11px] text-mist-dim">{WINDOW_LABEL[win] ?? win}: {pgLine}</div>
        </div>
      )}
    </div>
  );
}

// --- the traffic explorer ------------------------------------------------------
//
// Play-with-the-data surface: pick a window and a site, read WHERE VISITS LAND
// (a landing = a pageview whose referrer is not same-site), sort and search the
// table, tap a row to see that page's own sources and where those visitors went
// next. Counts are pageview aggregates from the cookieless dataset — "direct"
// means the browser sent no referrer (apps, bookmarks, email, most agent UIs),
// not "untracked": external referrers and ?c=/?ref=/utm_* campaigns are all read.

type LandingSort = 'landed' | 'direct' | 'external' | 'campaign';

function ExploreBlock({ explore, win }: { explore: CrmOverview['explore']; win: string }) {
  const [site, setSite] = useState<'all' | 'app' | 'lab'>('all');
  const [sort, setSort] = useState<LandingSort>('landed');
  const [needle, setNeedle] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  if (!explore) return null;

  const landings = (explore.landings[win] ?? [])
    .filter((l) => site === 'all' || l.site === site)
    .filter((l) => !needle || l.path.toLowerCase().includes(needle.toLowerCase()))
    .sort((a, b) => b[sort] - a[sort]);
  const edges = (explore.edges[win] ?? []).filter((e) => site === 'all' || e.site === site);
  const campaigns = (explore.campaigns[win] ?? []).filter((c) => site === 'all' || c.site === site);
  const open = openPath ? landings.find((l) => `${l.site}|${l.path}` === openPath) ?? null : null;
  const onwardOf = (l: { site: string; path: string }) =>
    edges.filter((e) => e.site === l.site && e.from === l.path).sort((a, b) => b.views - a.views).slice(0, 8);
  const inboundOf = (l: { site: string; path: string }) =>
    edges.filter((e) => e.site === l.site && e.to === l.path).sort((a, b) => b.views - a.views).slice(0, 8);
  const totals = landings.reduce(
    (a, l) => ({ landed: a.landed + l.landed, direct: a.direct + l.direct, external: a.external + l.external, campaign: a.campaign + l.campaign }),
    { landed: 0, direct: 0, external: 0, campaign: 0 },
  );

  const header = (key: LandingSort, label: string) => (
    <th
      className={`cursor-pointer px-3 py-2 text-right font-normal ${sort === key ? 'text-mist' : ''}`}
      onClick={() => setSort(key)}
      title="click to sort"
    >
      {label}{sort === key ? ' ↓' : ''}
    </th>
  );

  return (
    <div className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-mist">landings — {WINDOW_LABEL[win] ?? win}</span>
        {(['all', 'app', 'lab'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSite(s)}
            className={`cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-[10px] ${
              site === s ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
            }`}
          >
            {s === 'app' ? 'inference' : s}
          </button>
        ))}
        <span className="font-mono text-[10px] text-mist-faint">
          {totals.landed} landed · {totals.external} referred · {totals.campaign} tagged · {totals.direct} direct
        </span>
        <input
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          placeholder="filter paths"
          className="ml-auto w-28 rounded-full border border-white/10 bg-ink px-3 py-1 font-mono text-[11px] text-mist placeholder:text-mist-faint focus:outline-none"
        />
      </div>

      {campaigns.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {campaigns.map((c) => (
            <Chip key={`${c.site}|${c.campaign}`} tone="border-jade/30 text-jade">?{c.campaign} {c.views}</Chip>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-white/8">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-white/8 text-left text-mist-faint">
              <th className="px-3 py-2 font-normal">landing page</th>
              {header('landed', 'landed')}
              {header('external', 'referred')}
              {header('campaign', 'tagged')}
              {header('direct', 'direct')}
              <th className="px-3 py-2 text-right font-normal">moved on</th>
            </tr>
          </thead>
          <tbody>
            {landings.map((l) => {
              const key = `${l.site}|${l.path}`;
              const onward = onwardOf(l).reduce((a, e) => a + e.views, 0);
              return (
                <tr
                  key={key}
                  onClick={() => setOpenPath(openPath === key ? null : key)}
                  className={`cursor-pointer border-b border-white/5 last:border-0 hover:bg-white/[0.03] ${openPath === key ? 'bg-white/[0.04]' : ''}`}
                >
                  <td className="px-3 py-2 text-mist">
                    {site === 'all' && <span className="mr-1.5 text-mist-faint">{l.site === 'app' ? 'inf' : 'lab'}</span>}
                    {l.path}
                  </td>
                  <td className="px-3 py-2 text-right text-mist">{l.landed}</td>
                  <td className="px-3 py-2 text-right text-mist-dim">{l.external}</td>
                  <td className={`px-3 py-2 text-right ${l.campaign > 0 ? 'text-jade' : 'text-mist-faint'}`}>{l.campaign}</td>
                  <td className="px-3 py-2 text-right text-mist-faint">{l.direct}</td>
                  <td className="px-3 py-2 text-right text-mist-dim">{onward}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {landings.length === 0 && (
          <div className="px-3 py-4 text-center font-mono text-xs text-mist-faint">no landings in this cut</div>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-lg border border-white/12 bg-ink px-3 py-2.5">
          <div className="mb-1.5 font-mono text-[11px] text-mist">{open.path} — this window</div>
          <div className="grid gap-2 font-mono text-[11px] text-mist-dim sm:grid-cols-3">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-mist-faint">landed from</div>
              {/* foldLandings already labels direct arrivals as a 'direct' source row */}
              {open.sources.map((s) => (
                <div key={s.label}>{s.label} <span className="text-mist">{s.views}</span></div>
              ))}
              {open.sources.length === 0 && <div>none recorded</div>}
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-mist-faint">then moved to</div>
              {onwardOf(open).map((e) => (
                <div key={e.to}>{e.to} <span className="text-mist">{e.views}</span></div>
              ))}
              {onwardOf(open).length === 0 && <div>nowhere recorded</div>}
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-mist-faint">also reached from our pages</div>
              {inboundOf(open).map((e) => (
                <div key={e.from}>{e.from} <span className="text-mist">{e.views}</span></div>
              ))}
              {inboundOf(open).length === 0 && <div>none</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function TrafficTab({ data }: { data: CrmOverview }) {
  const { visitors, exposure } = data;
  // One window governs the whole tab: explorer, funnel and playground read the
  // same slice, so the numbers on screen are always about the same hours.
  const windows = data.explore?.windows ?? data.funnel?.windows ?? [];
  const [win, setWin] = useState('today');
  const selectedWin = windows.includes(win) ? win : windows[0] ?? 'today';

  // per-site daily series over the union of days, oldest→newest
  const sites = visitors ? [...new Set(visitors.daily.map((r) => r.site))].sort() : [];
  const days = visitors ? [...new Set(visitors.daily.map((r) => r.day))].sort() : [];
  const bySiteDay = new Map(visitors ? visitors.daily.map((r) => [`${r.site}|${r.day}`, r.views] as const) : []);
  const siteColor = (site: string, at: number) => (at === 0 ? SLATE : MIST); // fixed by entity order, never re-painted

  return (
    <div className="space-y-2">
      {windows.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {windows.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWin(w)}
              className={`shrink-0 cursor-pointer rounded-full border px-3 py-1 font-mono text-[11px] ${
                selectedWin === w ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
              }`}
              title="calendar windows are UTC"
            >
              {WINDOW_LABEL[w] ?? w}
            </button>
          ))}
        </div>
      )}
      {/* where visits land, and where they go — the explorer is the tab's centerpiece */}
      <ExploreBlock explore={data.explore} win={selectedWin} />
      {/* the money page: "did anyone try to sign in, and what did they do" */}
      <FunnelBlock funnel={data.funnel} win={selectedWin} />
      <div className="grid gap-2 lg:grid-cols-2">
        {visitors && days.length > 0 && (
          <TrendChart
            title={`visitors/day · ${visitors.totals.map((t) => `${t.site} ${t.views}`).join(' · ')}`}
            labels={days}
            series={sites.slice(0, 2).map((site, at) => ({
              name: site,
              color: siteColor(site, at),
              kind: 'line' as const,
              values: days.map((d) => bySiteDay.get(`${site}|${d}`) ?? 0),
            }))}
            format={(v) => String(Math.round(v))}
          />
        )}
        {visitors && visitors.channels.length > 0 && (
          <BarList
            title="visitors by channel"
            rows={visitors.channels.slice(0, 8).map((c) => ({
              label: `${c.channel}${c.delta !== 0 ? ` (${c.delta > 0 ? '+' : ''}${c.delta})` : ''}`,
              value: c.views,
              hint: `vs prior window: ${c.delta > 0 ? '+' : ''}${c.delta}`,
            }))}
          />
        )}
        {visitors && (
          <BarList
            title="top pages, 7d"
            rows={visitors.topPaths.slice(0, 8).map((p) => ({ label: `${p.site} ${p.path}`, value: p.views }))}
          />
        )}
        {exposure && (
          <div className="grid grid-cols-2 gap-2">
            {exposure.repos[0] && (
              <Stat
                label={`github · ${exposure.repos[0].repo.split('/').pop()}`}
                value={`★${exposure.repos[0].stars}`}
                sub={`${exposure.repos[0].views14d} views 14d · ${exposure.repos[0].clones14d} clones`}
              />
            )}
            {exposure.huggingface.length > 0 && (
              <Stat
                label="hf downloads 30d"
                value={String(exposure.huggingface.reduce((a, h) => a + h.downloads30d, 0))}
                sub={`${exposure.huggingface.length} cards`}
              />
            )}
          </div>
        )}
      </div>

      {/* 7d referrer chips: useful reference, but the explorer above answers the
          same question per window — so this is a collapsed appendix, not a strip
          competing with it. AI rows are floor counts (assistant apps strip the
          referrer more often than not). */}
      {((visitors && visitors.referrers.length > 0) || (exposure && exposure.referrers.length > 0)) && (
        <details className="rounded-xl border border-white/8 px-3.5 py-2">
          <summary className="cursor-pointer font-mono text-[11px] text-mist-faint">
            referrer appendix — 7d site referrers + GitHub repo referrers
          </summary>
          <div className="mt-2 space-y-2">
            {visitors && visitors.referrers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {visitors.referrers
                  .filter((r) => r.kind === 'ai')
                  .map((r) => (
                    <Chip key={`ai-${r.host}`} tone="border-jade/30 text-jade">
                      AI · {r.host || '?'} {r.views}
                    </Chip>
                  ))}
                {visitors.referrers
                  .filter((r) => r.kind !== 'ai')
                  .slice(0, 8)
                  .map((r) => (
                    <Chip key={`${r.kind}-${r.host}`}>
                      {r.kind}{r.host ? ` · ${r.host}` : ''} {r.views}
                    </Chip>
                  ))}
              </div>
            )}
            {exposure && exposure.referrers.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {exposure.referrers.slice(0, 6).map((r) => (
                  <Chip key={r.referrer}>gh ref · {r.referrer} {r.count}</Chip>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

// --- outreach tab ---------------------------------------------------------------
//
// Is the selling working: the outbound funnel, which channel signups actually
// carried, what ads bought, and the competitor watch that times outreach.

export function OutreachTab({ data }: { data: CrmOverview }) {
  const { signupSources, ads, outbound, competitors } = data;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 lg:grid-cols-2">
        <Stat
          label="outbound funnel · drafted → contacted → replied"
          value={`${outbound.drafted} → ${outbound.contacted} → ${outbound.replied}`}
          sub={
            outbound.bySource.length
              ? outbound.bySource.slice(0, 3).map((s) => `${s.source} ${s.drafted}/${s.contacted}/${s.replied}`).join(' · ')
              : null
          }
        />
        <BarList
          title="signups by channel"
          rows={signupSources.slice(0, 8).map((s) => ({ label: s.source, value: s.count }))}
        />
      </div>

      {/* per-source funnel — the table view of what each pond produced */}
      {outbound.bySource.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/8">
          <table className="w-full border-collapse font-mono text-[12px]">
            <thead>
              <tr className="border-b border-white/8 text-left text-mist-faint">
                <th className="px-3 py-2 font-normal">source</th>
                <th className="px-3 py-2 text-right font-normal">drafted</th>
                <th className="px-3 py-2 text-right font-normal">contacted</th>
                <th className="px-3 py-2 text-right font-normal">replied</th>
              </tr>
            </thead>
            <tbody>
              {outbound.bySource.map((s) => (
                <tr key={s.source} className="border-b border-white/5 last:border-0">
                  <td className="px-3 py-2 text-mist">{s.source}</td>
                  <td className="px-3 py-2 text-right text-mist-dim">{s.drafted}</td>
                  <td className="px-3 py-2 text-right text-mist-dim">{s.contacted}</td>
                  <td className={`px-3 py-2 text-right ${s.replied > 0 ? 'text-jade' : 'text-mist-faint'}`}>{s.replied}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ads — spend vs the funnel it bought; amber past the $150/payer kill gate */}
      {ads && ads.rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {ads.rows.map((a) => {
            const perPayer = a.costUsd != null && a.paid > 0 ? a.costUsd / a.paid : null;
            const breached = a.costUsd != null && (a.paid > 0 ? a.costUsd / a.paid > 150 : a.costUsd > 150);
            return (
              <Chip key={a.ref} tone={breached ? 'border-amber/40 text-amber' : 'border-white/10 text-mist-dim'}>
                {a.ref}: {a.costUsd != null ? `$${a.costUsd.toFixed(2)}` : '?'} · {a.clicks} clicks · {a.signups} signups · {a.paid} paid
                {perPayer != null && ` · $${perPayer.toFixed(0)}/payer`}
                {breached && ' · KILL GATE'}
              </Chip>
            );
          })}
          {ads.updatedAt == null && <Chip tone="border-amber/40 text-amber">ads: no push from the Ads Script yet</Chip>}
        </div>
      )}

      {/* competitor strip — the outreach-timing watch */}
      {competitors && competitors.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {competitors.map((c) => {
            const window =
              c.providers <= 1 ||
              (c.minUptimePct != null && c.minUptimePct < 95) ||
              (c.oursOutUsd != null && c.cheapestOutUsd != null && c.cheapestOutUsd > c.oursOutUsd * 1.5);
            return (
              <Chip key={c.model} tone={window ? 'border-amber/40 text-amber' : 'border-white/10 text-mist-dim'}>
                {c.comparedTo
                  ? `OR · ${c.model.split('/').pop()}: we are the only provider · class board ${c.comparedTo.split('/').pop()}: ${c.providers} providers $${c.cheapestInUsd ?? '?'}/${c.cheapestOutUsd ?? '?'} vs ours $${c.oursInUsd ?? '?'}/${c.oursOutUsd ?? '?'}`
                  : `OR · ${c.model.split('/').pop()}: ${c.providers} providers · $${c.cheapestInUsd ?? '?'}/${c.cheapestOutUsd ?? '?'} vs ours $${c.oursInUsd ?? '?'}/${c.oursOutUsd ?? '?'} · min ${c.minUptimePct ?? '?'}%`}
                {window && !c.comparedTo && ' · WINDOW'}
              </Chip>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- health tab ---------------------------------------------------------------

export function HealthTab({ data }: { data: CrmOverview }) {
  const { endpoint, realUsage, accounts, serving } = data;

  return (
    <div className="space-y-2">
      {/* First, above the endpoint probes: the sentinel sees things a per-model probe
          cannot — a dead tunnel, a gone instance, an on-box guard that will not start, and a
          replication loop that has stopped copying the request ledger off the box. */}
      <ServingBlock serving={serving} />
      <div className="flex flex-wrap items-center gap-1.5">
        {(endpoint?.models ?? []).map((m) => (
          <Chip key={m.model} tone={m.ok ? 'border-jade/30 text-jade' : 'border-coral/50 text-coral'}>
            {m.model.split('/').pop()} {m.ok ? 'up' : 'DOWN'} · ttft {m.ttftMs ?? '—'}ms · p50 {m.p50TtftMs ?? '—'}ms · {m.uptimePct}% 24h
          </Chip>
        ))}
        {endpoint && endpoint.models.length === 0 && <Chip>endpoint probes warming up</Chip>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {(realUsage ?? []).map((m) => (
          <Chip key={m.model} tone={m.errorPct > 1 ? 'border-coral/50 text-coral' : 'border-white/10 text-mist-dim'}>
            real · {m.model.split('/').pop()}: {m.requests24h} req 24h · {m.errorPct}% err
            {m.shedPct > 0 ? ` · ${m.shedPct}% shed` : ''} · {m.avgMs ?? '—'}ms
          </Chip>
        ))}
      </div>

      {/* the per-model 24h chart grids live on the models tab now — health answers
          "is anything on fire", models answers "what is each model doing" */}
      {accounts && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="accounts" value={String(accounts.total)} sub={`+${accounts.newWeek} this week`} />
          <Stat label="paying" value={String(accounts.withPurchase)} />
          <Stat label="internal" value={String(accounts.internal)} />
          <Stat label="suspended" value={String(accounts.suspended)} tone={accounts.suspended > 0 ? 'text-amber' : undefined} />
        </div>
      )}
    </div>
  );
}
