// Business overview, split across the CRM's tabs. The pipeline tab keeps only a
// one-line pulse strip; the numbers moved to Money / Growth / Health so each
// screen answers one question instead of all of them at once.
//
// Chart color law (validated against ink surfaces, 2026-08-22): at most two
// series per chart. jade+coral (revenue vs burn) sit in the CVD floor band and
// are therefore ALWAYS separated by mark kind too (bars vs line); slate-glow
// pairs with mist for same-kind series. Amber stays reserved for attention.

import type { CrmOverview, CrmUsageDay } from '../../../shared/types';
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

export function TrafficTab({ data }: { data: CrmOverview }) {
  const { visitors, exposure } = data;

  // per-site daily series over the union of days, oldest→newest
  const sites = visitors ? [...new Set(visitors.daily.map((r) => r.site))].sort() : [];
  const days = visitors ? [...new Set(visitors.daily.map((r) => r.day))].sort() : [];
  const bySiteDay = new Map(visitors ? visitors.daily.map((r) => [`${r.site}|${r.day}`, r.views] as const) : []);
  const siteColor = (site: string, at: number) => (at === 0 ? SLATE : MIST); // fixed by entity order, never re-painted

  return (
    <div className="space-y-2">
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

      {/* AI assistants + external referrers sending people to the sites. The ai
          rows are floor counts: assistant apps often strip the referrer. */}
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
