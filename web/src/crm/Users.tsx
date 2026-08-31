import { useMemo, useState } from 'react';
import type { CrmItem } from '../../../shared/types';
import { DoLink } from './Action';

/**
 * Users — the accounts screen.
 *
 * Accounts were sharing the pipeline with leads and directions, filtered by a `kind` chip. That is
 * the wrong shape: a lead is something to chase through stages, while an account is a customer whose
 * numbers you read. They want different columns, different sorting and different questions, and
 * mixing them meant the account facts (balance, requests, last active) survived only inside a
 * formatted `detail` string where nothing could sort on them.
 *
 * The questions this screen answers, in order:
 *   who is actually using the service, who has money left, and who went quiet.
 */

const money = (micro: number | null | undefined): string =>
  micro == null ? '—' : `$${(micro / 1_000_000).toFixed(2)}`;

const dayAge = (day: string | null): number | null => {
  if (!day) return null;
  const then = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
};

type Sort = 'spend' | 'requests' | 'today' | 'balance' | 'recent';
type Cut = 'all' | 'today' | 'active' | 'quiet' | 'never' | 'paying' | 'suspended';

const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'spend', label: 'spend' },
  { id: 'requests', label: 'requests' },
  { id: 'today', label: 'today' },
  { id: 'balance', label: 'balance' },
  { id: 'recent', label: 'last active' },
];

const CUTS: Array<{ id: Cut; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'today', label: 'active today' },
  { id: 'active', label: 'used it' },
  { id: 'quiet', label: 'went quiet' },
  { id: 'never', label: 'never used' },
  { id: 'paying', label: 'paid' },
  { id: 'suspended', label: 'suspended' },
];

/** Silent for this many days after real use is the moment worth an email. */
const QUIET_DAYS = 5;

function cutOf(item: CrmItem): Exclude<Cut, 'all'>[] {
  const m = item.metrics;
  if (!m) return [];
  const out: Exclude<Cut, 'all'>[] = [];
  if (m.suspended) out.push('suspended');
  if (m.paid) out.push('paying');
  if ((m.requestsToday ?? 0) > 0) out.push('today');
  if (m.requests > 0) {
    out.push('active');
    const age = dayAge(m.lastActiveDay);
    if (age != null && age >= QUIET_DAYS) out.push('quiet');
  } else {
    out.push('never');
  }
  return out;
}

export function UsersTab({
  items,
  onOpen,
}: {
  items: CrmItem[];
  onOpen: (id: string) => void;
}) {
  const [sort, setSort] = useState<Sort>('spend');
  const [cut, setCut] = useState<Cut>('all');
  const [query, setQuery] = useState('');

  const accounts = useMemo(() => items.filter((i) => i.kind === 'account' && i.metrics), [items]);

  const counts = useMemo(() => {
    const map = new Map<Cut, number>([['all', accounts.length]]);
    for (const item of accounts) {
      for (const c of cutOf(item)) map.set(c, (map.get(c) ?? 0) + 1);
    }
    return map;
  }, [accounts]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = accounts.filter((item) => {
      if (cut !== 'all' && !cutOf(item).includes(cut)) return false;
      if (!needle) return true;
      return `${item.title} ${item.metrics?.signupRef ?? ''}`.toLowerCase().includes(needle);
    });
    const key = (item: CrmItem): number => {
      const m = item.metrics!;
      if (sort === 'requests') return m.requests;
      if (sort === 'today') return m.requestsToday ?? -1;
      if (sort === 'balance') return m.balanceMicro ?? -1;
      if (sort === 'recent') return -(dayAge(m.lastActiveDay) ?? 99_999);
      return m.spentMicro;
    };
    return [...filtered].sort((a, b) => key(b) - key(a));
  }, [accounts, cut, query, sort]);

  // The totals a person actually wants at the top of a users screen.
  const summary = useMemo(() => {
    let spend = 0;
    let outstanding = 0;
    let used = 0;
    let activeToday = 0;
    let requestsToday = 0;
    let todayKnown = false;
    for (const item of accounts) {
      const m = item.metrics!;
      spend += m.spentMicro;
      if (m.balanceMicro != null) outstanding += Math.max(0, m.balanceMicro);
      if (m.requests > 0) used += 1;
      if (m.requestsToday != null) {
        todayKnown = true;
        requestsToday += m.requestsToday;
        if (m.requestsToday > 0) activeToday += 1;
      }
    }
    return { spend, outstanding, used, activeToday, requestsToday, todayKnown };
  }, [accounts]);

  if (accounts.length === 0) {
    return (
      <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
        no accounts yet
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="accounts" value={String(accounts.length)} />
        <Stat label="used it" value={`${summary.used} of ${accounts.length}`} />
        <Stat
          label="today"
          value={summary.todayKnown ? `${summary.activeToday} active · ${summary.requestsToday} req` : '—'}
        />
        <Stat label="spent" value={money(summary.spend)} />
        <Stat label="credit outstanding" value={money(summary.outstanding)} />
      </div>

      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        {CUTS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCut(c.id)}
            className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
              cut === c.id ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
            }`}
          >
            {c.label} {counts.get(c.id) ?? 0}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search"
          className="ml-auto w-28 min-w-0 shrink rounded-full border border-white/10 bg-ink px-3 py-1.5 font-mono text-[11px] text-mist placeholder:text-mist-faint focus:w-44 focus:outline-none sm:w-40"
        />
      </div>

      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        <span className="shrink-0 py-1.5 font-mono text-[11px] text-mist-faint">sort</span>
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSort(s.id)}
            className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
              sort === s.id ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/8">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-white/8 text-left text-mist-faint">
              <th className="px-3 py-2 font-normal">account</th>
              <th className="px-3 py-2 text-right font-normal">requests</th>
              <th className="px-3 py-2 text-right font-normal">today</th>
              <th className="px-3 py-2 text-right font-normal">spent</th>
              <th className="px-3 py-2 text-right font-normal">balance</th>
              <th className="px-3 py-2 text-right font-normal">last active</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => {
              const m = item.metrics!;
              const age = dayAge(m.lastActiveDay);
              const quiet = m.requests > 0 && age != null && age >= QUIET_DAYS;
              return (
                <tr
                  key={item.id}
                  onClick={() => onOpen(item.id)}
                  className="cursor-pointer border-b border-white/5 last:border-0 hover:bg-white/[0.03]"
                >
                  <td className="max-w-[28ch] px-3 py-2 text-mist" title={item.title}>
                    <div className="truncate">{item.title}</div>
                    {m.suspended && <span className="ml-0 text-coral">suspended</span>}
                    {m.paid && <span className="ml-1.5 text-amber">paid</span>}
                    {!m.enrolled && <span className="ml-1.5 text-mist-faint">unenrolled</span>}
                    <DoLink item={item} compact showMissing={false} />
                  </td>
                  <td className="px-3 py-2 text-right text-mist-dim">{m.requests}</td>
                  <td className={`px-3 py-2 text-right ${(m.requestsToday ?? 0) > 0 ? 'text-jade' : 'text-mist-faint'}`}>
                    {m.requestsToday == null ? '—' : m.requestsToday}
                  </td>
                  <td className="px-3 py-2 text-right text-mist-dim">{money(m.spentMicro)}</td>
                  <td className="px-3 py-2 text-right text-mist-dim">{money(m.balanceMicro)}</td>
                  <td className={`px-3 py-2 text-right ${quiet ? 'text-amber' : 'text-mist-faint'}`}>
                    {m.requests === 0
                      ? 'never'
                      : age == null
                        ? '—'
                        : age === 0
                          ? 'today'
                          : `${age}d ago`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {shown.length === 0 && (
        <div className="mt-3 rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
          nothing in this cut
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wide text-mist-faint">{label}</div>
      <div className="font-mono text-sm text-mist">{value}</div>
    </div>
  );
}
