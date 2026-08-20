// Business overview band — every accumulated number above the pipeline:
// income, outstanding balance, usage revenue, GPU burn + runway, visitors,
// accounts, and per-model endpoint health (TTFT / uptime). Desktop shows a
// six-across stat grid; phone wraps to two columns.

import type { CrmOverview, CrmUsageDay } from '../../../shared/types';

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

function Bars({ values, tone }: { values: number[]; tone: string }) {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  const w = 6, gap = 2;
  return (
    <svg width={values.length * (w + gap)} height={20} className="shrink-0" aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(1.5, (v / max) * 20);
        return <rect key={i} x={i * (w + gap)} y={20 - h} width={w} height={h} rx={1} className={tone} />;
      })}
    </svg>
  );
}

function Stat({ label, value, sub, spark }: { label: string; value: string; sub?: string | null; spark?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="text-lg leading-none text-mist">{value}</span>
        {spark}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] text-mist-dim">{sub}</div>}
    </div>
  );
}

const sum = (days: CrmUsageDay[], pick: (d: CrmUsageDay) => number) => days.reduce((a, d) => a + pick(d), 0);

export function Overview({ data }: { data: CrmOverview }) {
  const { money, accounts, usageDays, internalDays, visitors, endpoint, expenses, exposure } = data;

  const revenue7d = sum(usageDays, (d) => d.debitedMicro);
  const requests7d = sum(usageDays, (d) => d.requests);
  const internal7d = sum(internalDays, (d) => d.requests);
  const tokens7d = sum(usageDays, (d) => d.promptTokens + d.completionTokens);
  const today = usageDays[usageDays.length - 1];

  const visitorDays = (() => {
    if (!visitors) return [] as number[];
    const byDay = new Map<string, number>();
    for (const row of visitors.daily) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.views);
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  })();
  const visitors7d = visitors ? visitors.totals.reduce((a, t) => a + t.views, 0) : null;

  const burnDay = expenses ? expenses.burnPerHour * 24 : 0;
  const runwayDays = expenses?.creditUsd != null && burnDay > 0 ? expenses.creditUsd / burnDay : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="income"
          value={money ? usd(money.purchasedMicro) : '—'}
          sub={money ? `${money.purchases} purchase${money.purchases === 1 ? '' : 's'} all-time` : null}
        />
        <Stat
          label="usage revenue 7d"
          value={usd(revenue7d)}
          sub={today ? `today ${usd(today.debitedMicro)}` : null}
          spark={<Bars values={usageDays.map((d) => d.debitedMicro)} tone="fill-jade/70" />}
        />
        <Stat
          label="outstanding"
          value={money ? usd(money.outstandingMicro) : '—'}
          sub={money ? `granted ${usd(money.grantedMicro)}` : null}
        />
        <Stat
          label="gpu burn"
          value={expenses ? `$${expenses.burnPerHour.toFixed(2)}/hr` : '—'}
          sub={
            expenses
              ? `≈$${burnDay.toFixed(0)}/day · credit ${expenses.creditUsd == null ? '?' : `$${expenses.creditUsd.toFixed(0)}`}${
                  runwayDays != null ? ` (~${runwayDays.toFixed(1)}d)` : ''
                }`
              : null
          }
        />
        <Stat
          label="requests 7d"
          value={String(requests7d)}
          sub={`+${internal7d} internal · ${(tokens7d / 1_000_000).toFixed(1)}M tokens`}
          spark={<Bars values={usageDays.map((d) => d.requests)} tone="fill-slate-glow/70" />}
        />
        <Stat
          label="visitors 7d"
          value={visitors7d == null ? '—' : String(visitors7d)}
          sub={visitors ? visitors.totals.map((t) => `${t.site} ${t.views}`).join(' · ') : null}
          spark={<Bars values={visitorDays} tone="fill-amber/70" />}
        />
        {exposure && exposure.repos[0] && (
          <Stat
            label={`github · ${exposure.repos[0].repo.split('/').pop()}`}
            value={`★${exposure.repos[0].stars}`}
            sub={`${exposure.repos[0].views14d} views 14d (${exposure.repos[0].uniques14d} uniq) · ${exposure.repos[0].clones14d} clones`}
          />
        )}
        {exposure && exposure.huggingface.length > 0 && (
          <Stat
            label="hf downloads 30d"
            value={String(exposure.huggingface.reduce((a, h) => a + h.downloads30d, 0))}
            sub={exposure.huggingface
              .map((h) => `${h.id.split('/').pop()?.slice(0, 18)} ${h.downloads30d}`)
              .join(' · ')}
          />
        )}
        {exposure && exposure.crates.length > 0 && (
          <Stat
            label="crates installs"
            value={String(exposure.crates.reduce((a, c) => a + c.recentDownloads, 0))}
            sub={exposure.crates.map((c) => `${c.name} ${c.recentDownloads}`).join(' · ')}
          />
        )}
        {exposure && exposure.referrers.length > 0 && (
          <Stat
            label="gh referrers 14d"
            value={exposure.referrers[0]?.referrer ?? '—'}
            sub={exposure.referrers
              .slice(0, 4)
              .map((r) => `${r.referrer} ${r.count}`)
              .join(' · ')}
          />
        )}
      </div>

      {/* endpoint health + accounts — one thin strip, phone wraps */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(endpoint?.models ?? []).map((m) => (
          <span
            key={m.model}
            className={`rounded-full border px-2.5 py-1 font-mono text-[10px] ${
              m.ok ? 'border-jade/30 text-jade' : 'border-coral/50 text-coral'
            }`}
            title={`checked ${m.checkedAt}`}
          >
            {m.model.split('/').pop()} {m.ok ? 'up' : 'DOWN'} · ttft {m.ttftMs ?? '—'}ms · p50 {m.p50TtftMs ?? '—'}ms ·{' '}
            {m.uptimePct}% 24h
          </span>
        ))}
        {endpoint && endpoint.models.length === 0 && (
          <span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] text-mist-faint">
            endpoint probes warming up
          </span>
        )}
        {accounts && (
          <span className="ml-auto rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] text-mist-dim">
            {accounts.total} accounts · {accounts.withPurchase} paying · +{accounts.newWeek} this week
            {accounts.suspended > 0 && ` · ${accounts.suspended} suspended`}
          </span>
        )}
      </div>
    </div>
  );
}
