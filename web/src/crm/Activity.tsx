// Activity tab — what CHANGED, newest first. The board shows the pipeline's
// state; this feed shows its motion: leads arriving, signups, accounts going
// quiet or coming back, money landing, do-links fired. Day-grouped so "what
// happened yesterday" is one glance, not a diff against memory.
//
// Two things keep it readable, both view-only (the payload is untouched and the
// ledger is still append-only raw):
//
//  1. QUIET BY DEFAULT. Rows the server marked signal: false are hidden behind
//     one toggle. Those are the mechanical ones: a request counter ticking, a
//     stage move arithmetic made, a lead move that duplicates its own arrival
//     row. The abuse-shaped material they used to bury now has its own page.
//  2. ONE THING, ONE ROW. A burst of plus-tagged signups was four accounts
//     wearing one gmail mailbox, and it printed four rows plus their usage and
//     stage rows. The fold that collapses them lives in shared/crm-feed.ts,
//     because a folded row sums money and that arithmetic is pinned by a test.

import { useEffect, useMemo, useState } from 'react';
import { feedRowDetail, feedRowTitle, foldFeedRows, type FeedRow } from '../../../shared/crm-feed';
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

function dayLabel(day: string, today: string): string {
  if (day === today) return 'today';
  const days = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  if (days === 1) return 'yesterday';
  return day;
}

function EventRow({ row, onOpen }: { row: FeedRow; onOpen: (id: string) => void }) {
  const e = row.head;
  const folded = row.count > 1;
  const openable = e.itemId != null && e.type !== 'near-miss';
  const title = feedRowTitle(row, TYPE_LABEL[e.type]);
  const detail = feedRowDetail(row);
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
      className={`surface-row px-3 py-2.5 sm:px-4 ${openable ? 'cursor-pointer' : ''}`}
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
  week,
  onShowAll,
  onShowWeek,
  onOpen,
}: {
  activity: CrmActivity;
  /** the quiet toggle, held by CrmApp so the hash remembers it like the tab */
  showAll: boolean;
  week: boolean;
  onShowAll: (next: boolean) => void;
  onShowWeek: (next: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<CrmEventType | 'all'>('all');
  const today = activity.updatedAt.slice(0, 10);

  const inWindow = useMemo(
    () => (week ? activity.events : activity.events.filter((e) => e.at.slice(0, 10) === today)),
    [activity.events, week, today],
  );
  const inMode = useMemo(
    () => (showAll ? inWindow : inWindow.filter((e) => e.signal !== false)),
    [inWindow, showAll],
  );
  const hidden = inWindow.length - inMode.length;

  const counts = useMemo(() => {
    const map = new Map<CrmEventType, number>();
    for (const e of inMode) map.set(e.type, (map.get(e.type) ?? 0) + 1);
    return map;
  }, [inMode]);

  // A filter whose chip is gone from the bar is a filter nobody can see or clear:
  // picking a type with the quiet view off and then turning it on emptied the feed
  // and blamed the emptiness on mechanism, with no control on screen to undo it.
  useEffect(() => {
    if (filter !== 'all' && !counts.has(filter)) setFilter('all');
  }, [counts, filter]);

  const visible = filter === 'all' || !counts.has(filter) ? inMode : inMode.filter((e) => e.type === filter);

  const byDay = useMemo(() => {
    const groups: Array<{ day: string; events: CrmEvent[] }> = [];
    for (const e of visible) {
      const day = e.at.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.events.push(e);
      else groups.push({ day, events: [e] });
    }
    // The fold runs per day group, so a folded count is always a count within the
    // day its label names, and it never spans midnight.
    return groups.map((g) => ({ day: g.day, rows: foldFeedRows(g.events) }));
  }, [visible]);

  // The digest counts the same set the reader can see: advertising rows the
  // quiet view hides is how a "make it quiet" change turns into a lie.
  const digestCounts = (showAll ? activity.today : activity.todaySignal) ?? activity.today;
  const digest = DIGEST_ORDER
    .filter((t) => (digestCounts[t] ?? 0) > 0)
    .map((t) => `${digestCounts[t]} ${TYPE_LABEL[t]}`);

  return (
    <div className="space-y-4">
      <div className="mb-1">
        <h2 className="text-xl text-mist">Activity</h2>
        <p className="mt-1 text-sm text-mist-dim">What changed. Today unless you open the week.</p>
      </div>
      {/* today digest — the sentence the feed exists to answer */}
      <div className="signal-strip px-3.5 py-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">today</div>
        <div className="mt-1 text-sm text-mist">
          {digest.length ? digest.join(' · ') : 'nothing yet'}
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => onShowWeek(!week)}
          className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
            week ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
          }`}
        >
          {week ? '7 days' : 'today'}
        </button>
        <button
          type="button"
          onClick={() => onShowAll(!showAll)}
          title="the quiet view hides mechanical rows: request-only usage deltas, derived account stage moves, and stage moves that duplicate an item's own arrival row"
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
        <div key={group.day}>
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">
            {dayLabel(group.day, today)}
          </div>
          <div className="panel-surface">
            {group.rows.map((row) => (
              <EventRow key={row.key} row={row} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
      {visible.length === 0 && (
        <div className="empty-state px-3 py-6 text-center text-sm text-mist-dim">
          {hidden > 0
            ? `nothing but mechanism in this window (${hidden} quiet rows)`
            : 'no recorded activity yet: the differ seeds its baseline on first run and reports changes from there'}
        </div>
      )}
    </div>
  );
}
