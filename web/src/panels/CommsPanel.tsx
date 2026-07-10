import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Snapshot, CalendarEvent, CommsState } from '../../../shared/types';
import { connectGoogle } from '../api';
import { Panel, SectionLabel, RelTime, EmptyState, Row } from '../components/ui';

function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Non-auth trouble (transient fetch error, disabled) when google IS connected. */
function StatusBanner({ box }: { box: CommsState['email'] | CommsState['calendar'] }) {
  if (box.status === 'ok') return null;
  if (box.status === 'disabled') {
    return (
      <div className="mb-3 rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-mist-faint">
        disabled
      </div>
    );
  }
  return (
    <div className="mb-3 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">
      {box.error ?? box.status}
    </div>
  );
}

/** The in-app google fix — one prominent card replaces both columns when not connected. */
function ConnectGoogleCard({ hint }: { hint: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      className="glass-raised rise mx-auto mt-6 max-w-xl p-8 text-center"
      style={{ '--rise-i': 0 } as CSSProperties}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mist-faint">Google</div>
      <div className="mt-2 text-sm font-semibold text-mist">Mail and calendar are not connected.</div>
      {hint && <div className="mt-2 text-sm text-mist-dim">{hint}</div>}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await connectGoogle();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-5 rounded-lg bg-amber/15 px-6 py-2.5 font-mono text-sm text-amber transition-colors hover:bg-amber/25 disabled:opacity-40"
      >
        {busy ? '…' : 'connect google'}
      </button>
      {error && (
        <div className="mt-2 truncate font-mono text-xs text-coral" title={error}>
          {error}
        </div>
      )}
      <div className="mt-3 text-xs text-mist-faint">Google will ask for access, then return you here.</div>
    </section>
  );
}

/** http-shaped ids link directly; otherwise link to the calendar day view, so an
 *  event row is never a dead click. (The snapshot contract carries no htmlLink.) */
function eventLink(ev: CalendarEvent): string {
  if (ev.id.startsWith('http')) return ev.id;
  const d = new Date(ev.start);
  return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function EventRow({ ev, highlight, showDate }: { ev: CalendarEvent; highlight?: boolean; showDate?: boolean }) {
  const link = eventLink(ev);
  return (
    <Row href={link} className="group">
      <div
        className={`flex w-full min-w-0 items-baseline gap-3 ${highlight ? '-ml-2 border-l border-amber pl-2' : ''}`}
        title={ev.location ? `${ev.title} — ${ev.location}` : ev.title}
      >
        <span className="w-20 shrink-0 font-mono text-xs tabular-nums text-mist-dim sm:w-24">
          {ev.allDay ? 'all day' : `${hm(ev.start)}–${hm(ev.end)}`}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-mist">{ev.title}</span>
        {showDate && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-mist-faint">
            {new Date(ev.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()}
          </span>
        )}
      </div>
    </Row>
  );
}

export default function CommsPanel({ snapshot }: { snapshot: Snapshot }) {
  const { google, email, calendar } = snapshot.comms;
  const now = Date.now();

  // not connected → the fix lives here, not in a terminal somewhere else
  if (google && !google.connected) {
    return <ConnectGoogleCard hint={google.hint} />;
  }

  const today = [...calendar.today].sort((a, b) => a.start.localeCompare(b.start));
  // highlight the event happening now, else the next one to start today
  let highlightId: string | null = null;
  const current = today.find(
    (e) => !e.allDay && new Date(e.start).getTime() <= now && now < new Date(e.end).getTime(),
  );
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
  if (byDay.length === 0) rendered = <EmptyState>Your next seven days are clear.</EmptyState>;
  else
    rendered = byDay.map((g, gi) => (
      <div key={gi}>
        <SectionLabel>
          {g.label} <span className="tabular-nums">· {g.events.length}</span>
        </SectionLabel>
        <ul>
          {g.events.map((ev) => (
            <EventRow key={ev.id} ev={ev} showDate />
          ))}
        </ul>
      </div>
    ));

  const sourceChip = google?.source ? (
    <span className="font-mono text-[10px] text-mist-faint">via {google.source} token</span>
  ) : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Panel
        title="Mail"
        riseIndex={0}
        right={
          <span className="flex items-baseline gap-3">
            {sourceChip}
            <RelTime iso={snapshot.comms.updatedAt} />
          </span>
        }
      >
        <StatusBanner box={email} />
        <div className="mb-4 flex items-baseline gap-3">
          <span
            className={`font-mono text-4xl tabular-nums ${email.unreadCount > 0 ? 'text-amber' : 'text-mist-dim'}`}
          >
            {email.unreadCount}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">unread</span>
        </div>
        {email.threads.length === 0 ? (
          <EmptyState>Your inbox is clear.</EmptyState>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            {email.threads.map((t) => (
              <Row key={t.id} href={`https://mail.google.com/mail/u/0/#inbox/${t.id}`} className="group">
                <div
                  className={`flex w-full min-w-0 items-center gap-2 ${t.unread ? 'text-mist' : 'text-mist-dim'}`}
                  title={t.snippet}
                >
                  {t.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />}
                  <span className="w-28 shrink-0 truncate text-sm sm:w-40">{t.from}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{t.subject}</span>
                  <RelTime iso={t.date} />
                </div>
              </Row>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Calendar" riseIndex={1} right={<RelTime iso={snapshot.comms.updatedAt} />}>
        <StatusBanner box={calendar} />
        <SectionLabel>
          today{today.length > 0 && <span className="tabular-nums"> · {today.length}</span>}
        </SectionLabel>
        {today.length === 0 ? (
          <EmptyState>Your calendar is clear today.</EmptyState>
        ) : (
          <ul>
            {today.map((ev) => (
              <EventRow key={ev.id} ev={ev} highlight={ev.id === highlightId} />
            ))}
          </ul>
        )}
        <SectionLabel>
          next 7 days{upcoming.length > 0 && <span className="tabular-nums"> · {upcoming.length}</span>}
        </SectionLabel>
        <div className="max-h-80 overflow-y-auto">{rendered}</div>
      </Panel>
    </div>
  );
}
