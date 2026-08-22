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
  const { pnl, usageDays, visitors, endpoint, accounts, ads } = data;
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
  const runwayDays = expenses?.creditUsd != null && burnDay > 0 ? expenses.creditUsd / burnDay : null;

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
          sub={expenses ? `≈$${burnDay.toFixed(0)}/day · credit ${expenses.creditUsd == null ? '?' : `$${expenses.creditUsd.toFixed(0)}`}${runwayDays != null ? ` (~${runwayDays.toFixed(1)}d)` : ''}` : null}
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
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

// --- growth tab ---------------------------------------------------------------

export function GrowthTab({ data }: { data: CrmOverview }) {
  const { visitors, signupSources, ads, outbound, exposure, competitors } = data;

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
        <BarList
          title="signups by channel"
          rows={signupSources.slice(0, 8).map((s) => ({ label: s.source, value: s.count }))}
        />
        {visitors && (
          <BarList
            title="top pages, 7d"
            rows={visitors.topPaths.slice(0, 8).map((p) => ({ label: `${p.site} ${p.path}`, value: p.views }))}
          />
        )}
        <div className="space-y-2">
          <Stat
            label="outbound funnel"
            value={`${outbound.drafted} → ${outbound.contacted} → ${outbound.replied}`}
            sub={
              outbound.bySource.length
                ? outbound.bySource.slice(0, 3).map((s) => `${s.source} ${s.drafted}/${s.contacted}/${s.replied}`).join(' · ')
                : 'drafted → contacted → replied'
            }
          />
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
      </div>

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
                OR · {c.model.split('/').pop()}: {c.providers} providers · ${c.cheapestInUsd ?? '?'}/{c.cheapestOutUsd ?? '?'} vs ours ${c.oursInUsd ?? '?'}/{c.oursOutUsd ?? '?'} · min {c.minUptimePct ?? '?'}%
                {window && ' · WINDOW'}
              </Chip>
            );
          })}
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

// --- health tab ---------------------------------------------------------------

export function HealthTab({ data }: { data: CrmOverview }) {
  const { endpoint, realUsage, accounts } = data;
  return (
    <div className="space-y-2">
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
            real · {m.model.split('/').pop()}: {m.requests24h} req 24h · {m.errorPct}% err · {m.avgMs ?? '—'}ms
          </Chip>
        ))}
      </div>
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
