import type { ReactNode } from 'react';
import type { Snapshot, CalendarEvent, CommsState } from '../../../shared/types';
import { Panel, SectionLabel, RelTime, EmptyState } from '../components/ui';

function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function StatusBanner({ box, hint }: { box: CommsState['email'] | CommsState['calendar']; hint?: string }) {
  if (box.status === 'ok') return null;
  if (box.status === 'disabled') {
    return <div className="mb-3 rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-mist-faint">disabled</div>;
  }
  return (
    <div className="mb-3 rounded-lg border border-coral/40 bg-coral/10 p-3">
      <div className="text-sm text-coral">{box.error ?? box.status}</div>
      {box.status === 'auth-error' && hint && (
        <div className="mt-1 font-mono text-xs text-mist-dim">{hint}</div>
      )}
    </div>
  );
}

function EventRow({ ev, highlight, showDate }: { ev: CalendarEvent; highlight?: boolean; showDate?: boolean }) {
  return (
    <li
      className={`flex items-baseline gap-3 py-1.5 ${highlight ? '-ml-2 border-l border-amber pl-2' : ''}`}
      title={ev.location ? `${ev.title} — ${ev.location}` : ev.title}
    >
      <span className="w-24 shrink-0 font-mono text-xs text-mist-dim">
        {ev.allDay ? 'all day' : `${hm(ev.start)}–${hm(ev.end)}`}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{ev.title}</span>
      {showDate && (
        <span className="shrink-0 font-mono text-xs text-mist-faint">
          {new Date(ev.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()}
        </span>
      )}
    </li>
  );
}

export default function CommsPanel({ snapshot }: { snapshot: Snapshot }) {
  const { email, calendar } = snapshot.comms;
  const now = Date.now();

  const today = [...calendar.today].sort((a, b) => a.start.localeCompare(b.start));
  // highlight the event happening now, else the next one to start today
  let highlightId: string | null = null;
  const current = today.find((e) => !e.allDay && new Date(e.start).getTime() <= now && now < new Date(e.end).getTime());
  if (current) highlightId = current.id;
  else highlightId = today.find((e) => new Date(e.start).getTime() > now)?.id ?? null;

  const upcoming = [...calendar.upcoming].sort((a, b) => a.start.localeCompare(b.start));
  const byDay: { label: string; events: CalendarEvent[] }[] = [];
  for (const ev of upcoming) {
    const d = new Date(ev.start);
    const label = d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const last = byDay[byDay.length - 1];
    if (last && last.label === label && new Date(last.events[0].start).toDateString() === d.toDateString()) {
      last.events.push(ev);
    } else {
      byDay.push({ label, events: [ev] });
    }
  }

  let rendered: ReactNode;
  if (byDay.length === 0) rendered = <EmptyState>nothing in the next 7 days</EmptyState>;
  else
    rendered = byDay.map((g, gi) => (
      <div key={gi}>
        <SectionLabel>{g.label}</SectionLabel>
        <ul>
          {g.events.map((ev) => (
            <EventRow key={ev.id} ev={ev} showDate />
          ))}
        </ul>
      </div>
    ));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="mail" riseIndex={0} right={<RelTime iso={snapshot.comms.updatedAt} />}>
        <StatusBanner box={email} hint="token: ~/.hermes/google_token.json" />
        <div className="mb-4 flex items-baseline gap-3">
          <span className={`font-display text-5xl italic ${email.unreadCount > 0 ? 'text-amber' : 'text-mist-dim'}`}>
            {email.unreadCount}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-widest text-mist-faint">unread</span>
        </div>
        {email.threads.length === 0 ? (
          <EmptyState>inbox is quiet</EmptyState>
        ) : (
          <ul className="max-h-[28rem] overflow-y-auto">
            {email.threads.map((t) => (
              <li
                key={t.id}
                title={t.snippet}
                className={`flex items-center gap-2 border-b py-1.5 last:border-b-0 hairline ${
                  t.unread ? 'text-mist' : 'text-mist-dim'
                }`}
              >
                {t.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />}
                <span className="w-40 shrink-0 truncate text-sm">{t.from}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{t.subject}</span>
                <RelTime iso={t.date} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="calendar" riseIndex={1}>
        <StatusBanner box={calendar} />
        <SectionLabel>today</SectionLabel>
        {today.length === 0 ? (
          <EmptyState>no events today</EmptyState>
        ) : (
          <ul>
            {today.map((ev) => (
              <EventRow key={ev.id} ev={ev} highlight={ev.id === highlightId} />
            ))}
          </ul>
        )}
        <SectionLabel>next 7 days</SectionLabel>
        <div className="max-h-80 overflow-y-auto">{rendered}</div>
      </Panel>
    </div>
  );
}
