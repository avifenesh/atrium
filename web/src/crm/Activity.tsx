// Activity tab — what CHANGED, newest first. The board shows the pipeline's
// state; this feed shows its motion: leads arriving, signups, accounts going
// quiet or coming back, money landing, do-links fired. Day-grouped so "what
// happened yesterday" is one glance, not a diff against memory.
//
// Two things keep it readable, both view-only (the payload is untouched and the
// ledger is still append-only raw):
//
//  1. QUIET BY DEFAULT. Rows the server marked signal: false are hidden behind
//     one toggle. Those are the mechanical ones — a request counter ticking, an
//     account stage move arithmetic made, a near miss the ingest gate logged for
//     itself. The abuse-shaped material they used to bury now has its own page.
//  2. ONE IDENTITY, ONE ROW. A burst of plus-tagged signups was four accounts
//     wearing one gmail mailbox, and it printed four rows plus their usage and
//     stage rows. A consecutive run of same-type account rows now collapses onto
//     the strongest handle its members share: one folded mailbox, else one
//     private email domain (the shape a plus-tag fold cannot see).

import { useMemo, useState } from 'react';
import { addressIn, foldMailboxIn, isPublicProvider, mailboxDomain } from '../../../shared/mailbox';
import type { CrmActivity, CrmEvent, CrmEventType } from '../../../shared/types';

const TYPE_LABEL: Record<CrmEventType, string> = {
  'lead-new': 'lead',
  'near-miss': 'near miss',
  'direction-new': 'direction',
  'account-new': 'signup',
  'stage-change': 'stage',
  'account-quiet': 'quiet',
  'account-resumed': 'back',
  'account-usage': 'usage',
  'contact-logged': 'touch',
  'do-launched': 'do',
};

const TYPE_TONE: Record<CrmEventType, string> = {
  'lead-new': 'border-slate-glow/40 text-slate-glow',
  'near-miss': 'border-white/10 text-mist-faint',
  'direction-new': 'border-amber/30 text-amber',
  'account-new': 'border-jade/40 text-jade',
  'stage-change': 'border-white/15 text-mist',
  'account-quiet': 'border-coral/40 text-coral',
  'account-resumed': 'border-jade/30 text-jade',
  'account-usage': 'border-white/10 text-mist-dim',
  'contact-logged': 'border-white/10 text-mist-dim',
  'do-launched': 'border-amber/30 text-amber',
};

/** The digest reads in this order: money first, then people, then process. */
const DIGEST_ORDER: CrmEventType[] = [
  'account-new', 'account-usage', 'account-resumed', 'account-quiet',
  'lead-new', 'near-miss', 'stage-change', 'direction-new', 'contact-logged', 'do-launched',
];

/** Addresses printed inside one folded row before it says "and N more". */
const MEMBER_PREVIEW = 3;

function dayLabel(day: string, today: string): string {
  if (day === today) return 'today';
  const days = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  if (days === 1) return 'yesterday';
  return day;
}

/** One printed line: a single event, or a run of them about one identity handle. */
interface FeedRow {
  key: string;
  /** the newest event in the run: its timestamp, its type, its drawer target */
  head: CrmEvent;
  count: number;
  /** the handle every member of the run shares, and what kind of handle it is */
  handle: string | null;
  handleKind: 'mailbox' | 'domain';
  /** the folded mailbox all members share, null once the run widened to a domain */
  mailbox: string | null;
  domain: string | null;
  /** the distinct addresses behind a folded row, newest first */
  members: string[];
}

function handlesOf(e: CrmEvent): { address: string | null; mailbox: string | null; domain: string | null } {
  // Only account rows fold: an itemId starting with `tenant:` is the guarantee
  // that the address in the title belongs to an account, and is not a word
  // inside a lead's thread title.
  if (!e.itemId?.startsWith('tenant:')) return { address: null, mailbox: null, domain: null };
  const address = addressIn(e.title);
  if (!address) return { address: null, mailbox: null, domain: null };
  const domain = mailboxDomain(address);
  return {
    address,
    mailbox: foldMailboxIn(e.title),
    // A public provider is not a handle: two gmail addresses with different
    // local parts are two people, and folding them would hide a real signup.
    domain: domain && !isPublicProvider(domain) ? domain : null,
  };
}

/**
 * Collapse a consecutive run of same-type account rows onto the strongest handle
 * its members share: one folded mailbox, else one private email domain.
 *
 * Both shapes were in the same flood. Four signups wearing plus tags on one gmail
 * mailbox are one person; eighty-six signups on one throwaway domain are one
 * arrival, and no plus-tag fold can see them because every local part differs.
 * The run never crosses a type, so a line can say "signup x86" and mean it.
 */
function foldRows(events: CrmEvent[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const e of events) {
    const { address, mailbox, domain } = handlesOf(e);
    const last = rows[rows.length - 1];
    const sameMailbox = last != null && mailbox != null && last.mailbox === mailbox;
    const sameDomain = last != null && domain != null && last.domain === domain;
    if (last && last.head.type === e.type && (sameMailbox || sameDomain)) {
      last.count += 1;
      if (!sameMailbox) {
        // the run outgrew one mailbox, so the handle it can honestly name is the domain
        last.mailbox = null;
        last.handle = domain;
        last.handleKind = 'domain';
      }
      if (address && !last.members.includes(address)) last.members.push(address);
      continue;
    }
    rows.push({
      key: `${e.at}-${e.type}-${rows.length}`,
      head: e,
      count: 1,
      handle: mailbox,
      handleKind: 'mailbox',
      mailbox,
      domain,
      members: address ? [address] : [],
    });
  }
  return rows;
}

function foldedDetail(row: FeedRow): string {
  const shown = row.members.slice(0, MEMBER_PREVIEW).join(' · ');
  const rest = row.count - Math.min(row.members.length, MEMBER_PREVIEW);
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

function EventRow({ row, onOpen }: { row: FeedRow; onOpen: (id: string) => void }) {
  const e = row.head;
  const folded = row.count > 1;
  const openable = e.itemId != null && e.type !== 'near-miss';
  const title = folded
    ? `${TYPE_LABEL[e.type]} x${row.count}, ${row.handle} (one ${row.handleKind})`
    : e.title;
  const detail = folded ? foldedDetail(row) : e.detail;
  return (
    <div
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={openable ? () => onOpen(e.itemId as string) : undefined}
      onKeyDown={openable ? (ev) => {
        if (ev.target !== ev.currentTarget) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen(e.itemId as string);
        }
      } : undefined}
      className={`rounded-xl border border-white/8 bg-ink-2 px-3.5 py-2.5 ${openable ? 'cursor-pointer transition-colors hover:border-white/20' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${TYPE_TONE[e.type]}`}>
          {TYPE_LABEL[e.type]}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-mist">{title}</span>
        <span className="shrink-0 font-mono text-[10px] text-mist-faint">{e.at.slice(11, 16)}Z</span>
      </div>
      {detail && <div className="mt-1 truncate pl-1 text-xs text-mist-dim">{detail}</div>}
      {!folded && e.url && (
        <a
          href={e.url}
          target="_blank"
          rel="noreferrer"
          onClick={(ev) => ev.stopPropagation()}
          className="mt-0.5 block truncate pl-1 font-mono text-[10px] text-slate-glow underline"
        >
          {e.url}
        </a>
      )}
    </div>
  );
}

export function ActivityTab({
  activity,
  showAll,
  onShowAll,
  onOpen,
}: {
  activity: CrmActivity;
  /** the quiet toggle, held by CrmApp so the hash remembers it like the tab */
  showAll: boolean;
  onShowAll: (next: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<CrmEventType | 'all'>('all');

  const inMode = useMemo(
    () => (showAll ? activity.events : activity.events.filter((e) => e.signal !== false)),
    [activity.events, showAll],
  );
  const hidden = activity.events.length - inMode.length;

  const counts = useMemo(() => {
    const map = new Map<CrmEventType, number>();
    for (const e of inMode) map.set(e.type, (map.get(e.type) ?? 0) + 1);
    return map;
  }, [inMode]);

  const visible = filter === 'all' ? inMode : inMode.filter((e) => e.type === filter);

  const today = activity.updatedAt.slice(0, 10);
  const byDay = useMemo(() => {
    const groups: Array<{ day: string; events: CrmEvent[] }> = [];
    for (const e of visible) {
      const day = e.at.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.events.push(e);
      else groups.push({ day, events: [e] });
    }
    // The fold runs per day, so a run never spans midnight and a folded count is
    // always a count within the day its label names.
    return groups.map((g) => ({ day: g.day, rows: foldRows(g.events) }));
  }, [visible]);

  // The digest counts the same set the reader can see: advertising rows the
  // quiet view hides is how a "make it quiet" change turns into a lie.
  const digestCounts = (showAll ? activity.today : activity.todaySignal) ?? activity.today;
  const digest = DIGEST_ORDER
    .filter((t) => (digestCounts[t] ?? 0) > 0)
    .map((t) => `${digestCounts[t]} ${TYPE_LABEL[t]}`);

  return (
    <div className="space-y-3">
      {/* today digest — the sentence the feed exists to answer */}
      <div className="rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">today</div>
        <div className="mt-1 text-sm text-mist">
          {digest.length ? digest.join(' · ') : 'nothing yet'}
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => onShowAll(!showAll)}
          title="the quiet view hides mechanical rows: request-only usage deltas, derived account stage moves, ingest-gate near misses"
          className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
            showAll ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
          }`}
        >
          {showAll ? 'everything' : `quiet, ${hidden} hidden`}
        </button>
        <button
          type="button"
          onClick={() => setFilter('all')}
          className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
            filter === 'all' ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
          }`}
        >
          all {inMode.length}
        </button>
        {DIGEST_ORDER.filter((t) => (counts.get(t) ?? 0) > 0).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setFilter(filter === t ? 'all' : t)}
            className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
              filter === t ? 'border-white/25 bg-white/5 text-mist' : `border-white/8 ${TYPE_TONE[t].split(' ')[1]}`
            }`}
          >
            {TYPE_LABEL[t]} {counts.get(t)}
          </button>
        ))}
      </div>

      {byDay.map((group) => (
        <div key={group.day} className="space-y-1.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">
            {dayLabel(group.day, today)}
          </div>
          {group.rows.map((row) => (
            <EventRow key={row.key} row={row} onOpen={onOpen} />
          ))}
        </div>
      ))}
      {visible.length === 0 && (
        <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
          {hidden > 0
            ? `nothing but mechanism in this window (${hidden} quiet rows)`
            : 'no recorded activity yet: the differ seeds its baseline on first run and reports changes from there'}
        </div>
      )}
    </div>
  );
}
