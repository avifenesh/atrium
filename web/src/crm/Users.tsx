import { Fragment, useMemo, useState } from 'react';
import { groupUsersByMailbox, type UserGroup, type UserMetrics } from '../../../shared/crm-users';
import { foldMailbox } from '../../../shared/mailbox';
import type { CrmItem } from '../../../shared/types';
import { DoLink } from './Action';

/**
 * Users: the accounts screen.
 *
 * Accounts were sharing the pipeline with leads and directions, filtered by a `kind` chip. That is
 * the wrong shape: a lead is something to chase through stages, while an account is a customer whose
 * numbers you read. They want different columns, different sorting and different questions, and
 * mixing them meant the account facts (balance, requests, last active) survived only inside a
 * formatted `detail` string where nothing could sort on them.
 *
 * The questions this screen answers, in order:
 *   who is actually using the service, who has money left, and who went quiet.
 *
 * ONE PERSON, ONE ROW. Accounts whose addresses fold to the same mailbox print as a single row
 * carrying the group's totals, and expand to their members unchanged. The activity feed and the
 * security page already read the owner's six plus-tagged signups as one identity; this screen was
 * the last one showing them as six customers. The fold itself is shared/crm-users.ts, because a
 * collapsed group is the only place its members' money appears and that arithmetic is pinned by a
 * test (web/ has no test runner).
 */

/** Nothing to report. A dash-shaped glyph, not a dash, following Security.tsx: em dashes are out by
 *  the owner's writing rule, and a bare hyphen reads as a minus sign in a money column. */
const NONE = '·';

const money = (micro: number | null | undefined): string =>
  micro == null ? NONE : `$${(micro / 1_000_000).toFixed(2)}`;

const dayAge = (day: string | null): number | null => {
  if (!day) return null;
  const then = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
};

type Sort = 'spend' | 'requests' | 'today' | 'balance' | 'recent';
type Cut = 'all' | 'today' | 'active' | 'quiet' | 'never' | 'paying';

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
];

/** Silent for this many days after real use is the moment worth an email. */
const QUIET_DAYS = 5;

function cutOf(item: CrmItem): Exclude<Cut, 'all'>[] {
  const m = item.metrics;
  if (!m) return [];
  const out: Exclude<Cut, 'all'>[] = [];
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

/** One number to order on. It takes the metric SHAPE, not the item, so a group is ranked by its
 *  totals through the same function that ranks a single account. */
function sortKey(m: UserMetrics, sort: Sort): number {
  if (sort === 'requests') return m.requests;
  if (sort === 'today') return m.requestsToday ?? -1;
  if (sort === 'balance') return m.balanceMicro ?? -1;
  if (sort === 'recent') return -(dayAge(m.lastActiveDay) ?? 99_999);
  return m.spentMicro;
}

/** The last-active cell, for an account or for a group's totals. `requests === 0` outranks the day:
 *  an account that never called has no last-active day to be quiet since. */
function lastActive(m: UserMetrics): { text: string; quiet: boolean } {
  const age = dayAge(m.lastActiveDay);
  return {
    text: m.requests === 0 ? 'never' : age == null ? NONE : age === 0 ? 'today' : `${age}d ago`,
    quiet: m.requests > 0 && age != null && age >= QUIET_DAYS,
  };
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /* Suspended accounts leave the working set entirely (owner ask 2026-08-31:
   * "hide the suspended, that bothers me"). The 77 farmed signups from the
   * asashi flood turned every cut into a wall of dead rows. They used to sit in
   * a collapsed section at the bottom of this screen; the list itself now lives
   * on the security tab, whose subject they are, and what is left here is the
   * count, so this screen still says how many accounts it is not showing. */
  const all = useMemo(() => items.filter((i) => i.kind === 'account' && i.metrics), [items]);
  const accounts = useMemo(() => all.filter((i) => !i.metrics!.suspended), [all]);
  const suspendedCount = all.length - accounts.length;

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
      // The folded mailbox is part of the haystack: it is the name the grouped row prints, and no
      // plus-tagged member's own title contains it.
      const fold = foldMailbox(item.title) ?? '';
      return `${item.title} ${fold} ${item.metrics?.signupRef ?? ''}`.toLowerCase().includes(needle);
    });
    /* Cut and search run per ACCOUNT, before the fold, which is what keeps the chip counts honest:
     * they count accounts, so a group shown under a cut holds exactly the members that cut selected
     * and its totals are the totals of those. */
    const groups = groupUsersByMailbox(filtered);
    for (const group of groups) {
      group.members.sort((a, b) => sortKey(b.metrics!, sort) - sortKey(a.metrics!, sort));
    }
    return groups.sort((a, b) => sortKey(b.totals, sort) - sortKey(a.totals, sort));
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

  if (all.length === 0) {
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
          value={summary.todayKnown ? `${summary.activeToday} active · ${summary.requestsToday} req` : NONE}
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
            {shown.map((group) =>
              /* One account is one plain row, with no expander and nothing to reveal: the fold
                 hands back a group of one so this screen has a single code path, not so a lone
                 customer starts looking like a cluster. */
              group.accounts === 1 ? (
                <AccountRow key={group.members[0].id} item={group.members[0]} onOpen={onOpen} />
              ) : (
                <Fragment key={group.key}>
                  <GroupRow
                    group={group}
                    expanded={expanded.has(group.key)}
                    onToggle={() => toggle(group.key)}
                  />
                  {expanded.has(group.key) &&
                    group.members.map((item) => (
                      <AccountRow key={item.id} item={item} onOpen={onOpen} nested />
                    ))}
                </Fragment>
              ),
            )}
          </tbody>
        </table>
      </div>

      {shown.length === 0 && (
        <div className="mt-3 rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
          nothing in this cut
        </div>
      )}

      {/* One line, not a list: the rows themselves (and the drawer that restores
          them) are on the security page now. */}
      {suspendedCount > 0 && (
        <a
          href="#security"
          className="mt-4 block rounded-xl border border-white/8 px-3 py-2 font-mono text-[11px] text-mist-faint hover:border-white/20"
        >
          {suspendedCount} suspended {suspendedCount === 1 ? 'account is' : 'accounts are'} not in these
          counts, they are on the security page →
        </a>
      )}
    </div>
  );
}

/** One account. `nested` only indents the first cell: a member revealed under its group keeps the
 *  same columns, the same badges and the same drawer click target it has on its own. */
function AccountRow({
  item,
  onOpen,
  nested = false,
}: {
  item: CrmItem;
  onOpen: (id: string) => void;
  nested?: boolean;
}) {
  const m = item.metrics!;
  const last = lastActive(m);
  return (
    <tr
      onClick={() => onOpen(item.id)}
      className="cursor-pointer border-b border-white/5 last:border-0 hover:bg-white/[0.03]"
    >
      <td className={`max-w-[28ch] py-2 pr-3 text-mist ${nested ? 'pl-7' : 'pl-3'}`} title={item.title}>
        <div className="truncate">{item.title}</div>
        {m.suspended && <span className="ml-0 text-coral">suspended</span>}
        {m.paid && <span className="ml-1.5 text-amber">paid</span>}
        {!m.enrolled && <span className="ml-1.5 text-mist-faint">unenrolled</span>}
        <DoLink item={item} compact showMissing={false} />
      </td>
      <td className="px-3 py-2 text-right text-mist-dim">{m.requests}</td>
      <td className={`px-3 py-2 text-right ${(m.requestsToday ?? 0) > 0 ? 'text-jade' : 'text-mist-faint'}`}>
        {m.requestsToday == null ? NONE : m.requestsToday}
      </td>
      <td className="px-3 py-2 text-right text-mist-dim">{money(m.spentMicro)}</td>
      <td className="px-3 py-2 text-right text-mist-dim">{money(m.balanceMicro)}</td>
      <td className={`px-3 py-2 text-right ${last.quiet ? 'text-amber' : 'text-mist-faint'}`}>{last.text}</td>
    </tr>
  );
}

/** Several accounts, one mailbox, one row. Every column is the group's aggregate, so the collapsed
 *  row is a true reading of the whole mailbox and not a preview of its first member. Clicking it
 *  expands, because a group is not an item and has no drawer of its own. */
function GroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: UserGroup<CrmItem>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = group.totals;
  const last = lastActive(t);
  return (
    <tr
      onClick={onToggle}
      aria-expanded={expanded}
      className="cursor-pointer border-b border-white/5 bg-white/[0.02] last:border-0 hover:bg-white/[0.05]"
    >
      <td className="max-w-[28ch] px-3 py-2 text-mist" title={group.members.map((m) => m.title).join(' ')}>
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-[10px] text-mist-faint">{expanded ? '▾' : '▸'}</span>
          <span className="truncate">{group.label}</span>
        </div>
        <div className="pl-4 text-[10px] text-mist-faint">
          {group.accounts} accounts, one mailbox
          {t.paid && <span className="ml-1.5 text-amber">paid</span>}
        </div>
      </td>
      <td className="px-3 py-2 text-right text-mist-dim">{t.requests}</td>
      <td className={`px-3 py-2 text-right ${(t.requestsToday ?? 0) > 0 ? 'text-jade' : 'text-mist-faint'}`}>
        {t.requestsToday == null ? NONE : t.requestsToday}
      </td>
      <td className="px-3 py-2 text-right text-mist-dim">{money(t.spentMicro)}</td>
      <td className="px-3 py-2 text-right text-mist-dim">{money(t.balanceMicro)}</td>
      <td className={`px-3 py-2 text-right ${last.quiet ? 'text-amber' : 'text-mist-faint'}`}>{last.text}</td>
    </tr>
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
