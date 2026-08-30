// Activity tab — what CHANGED, newest first. The board shows the pipeline's
// state; this feed shows its motion: leads arriving (and the near-misses the
// ingest gate turned away), signups, stage moves, accounts going quiet or
// coming back, spend landing, do-links fired. Day-grouped so "what happened
// yesterday" is one glance, not a diff against memory.

import { useMemo, useState } from 'react';
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

function EventRow({ e, onOpen }: { e: CrmEvent; onOpen: (id: string) => void }) {
  const openable = e.itemId != null && e.type !== 'near-miss';
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
        <span className="min-w-0 flex-1 truncate text-sm text-mist">{e.title}</span>
        <span className="shrink-0 font-mono text-[10px] text-mist-faint">{e.at.slice(11, 16)}Z</span>
      </div>
      {e.detail && <div className="mt-1 pl-1 text-xs text-mist-dim">{e.detail}</div>}
      {e.url && (
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

export function ActivityTab({ activity, onOpen }: { activity: CrmActivity; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<CrmEventType | 'all'>('all');

  const counts = useMemo(() => {
    const map = new Map<CrmEventType, number>();
    for (const e of activity.events) map.set(e.type, (map.get(e.type) ?? 0) + 1);
    return map;
  }, [activity.events]);

  const visible = filter === 'all' ? activity.events : activity.events.filter((e) => e.type === filter);

  const today = activity.updatedAt.slice(0, 10);
  const byDay = useMemo(() => {
    const groups: Array<{ day: string; events: CrmEvent[] }> = [];
    for (const e of visible) {
      const day = e.at.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.events.push(e);
      else groups.push({ day, events: [e] });
    }
    return groups;
  }, [visible]);

  const digest = DIGEST_ORDER
    .filter((t) => (activity.today[t] ?? 0) > 0)
    .map((t) => `${activity.today[t]} ${TYPE_LABEL[t]}`);

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
          onClick={() => setFilter('all')}
          className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
            filter === 'all' ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
          }`}
        >
          all {activity.events.length}
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
          {group.events.map((e, at) => (
            <EventRow key={`${e.at}-${e.type}-${at}`} e={e} onOpen={onOpen} />
          ))}
        </div>
      ))}
      {visible.length === 0 && (
        <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
          no recorded activity yet — the differ seeds its baseline on first run and reports changes from there
        </div>
      )}
    </div>
  );
}
