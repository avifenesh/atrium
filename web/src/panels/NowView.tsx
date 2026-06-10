import type { CSSProperties } from 'react';
import { isMuted } from '../api';
import { Dot, EmptyState, MuteButton, Panel, RelTime, Row, SendToEigen } from '../components/ui';
import Spark from '../components/Spark';
import { getSeries, pctTone, useNow, useTweenNumber } from '../hooks';
import type { CalendarEvent, Snapshot } from '../../../shared/types';

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function hhmmss(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function pctClass(pct: number): string {
  return pct > 90 ? 'text-coral' : pct > 75 ? 'text-amber' : 'text-mist';
}

/** Hero stat — one of the two sanctioned serif uses (the other is the wordmark). */
function Stat({
  value,
  label,
  accent = false,
  onClick,
}: {
  value: number;
  label: string;
  accent?: boolean;
  onClick: () => void;
}) {
  const display = useTweenNumber(value);
  // Instrument Serif has no tnum feature (digits are proportional), so the glide
  // would reflow the whole hero strip every frame — reserve a stable slot instead:
  // min-width in ch (the '0' advance, the font's widest digit) per target digit
  const digits = String(Math.abs(Math.round(value))).length;
  // zero de-emphasis keys off the real value, not the tween, so it never flickers mid-glide
  return (
    <button onClick={onClick} className="group flex cursor-pointer flex-col items-start rounded-lg px-2 text-left">
      <span
        style={{ minWidth: `${digits}ch` }}
        className={`inline-block font-display text-5xl italic leading-none xl:text-6xl ${accent ? 'text-amber' : value === 0 ? 'text-mist-faint' : 'text-mist'}`}
      >
        {display}
      </span>
      <span className="mt-2 font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint transition-colors group-hover:text-mist-dim">
        {label}
      </span>
    </button>
  );
}

/** "next in 1h 20m" — quiet until 15 minutes out, then amber. Null when nothing ahead. */
function NextEventCountdown({ events }: { events: CalendarEvent[] }) {
  const now = useNow(30000);
  const next = events
    .filter((ev) => !ev.allDay && new Date(ev.start).getTime() > now)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[0];
  if (!next) return null;
  const mins = Math.max(1, Math.ceil((new Date(next.start).getTime() - now) / 60000));
  const rel = mins < 60 ? `${mins}m` : mins % 60 === 0 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return (
    <span className={`whitespace-nowrap font-mono text-[11px] tabular-nums ${mins < 15 ? 'text-amber' : 'text-mist-faint'}`}>
      next in {rel}
    </span>
  );
}

export default function NowView({
  snapshot,
  onNavigate,
  onOpenQuiet,
  onOpenItem,
}: {
  snapshot: Snapshot;
  onNavigate: (viewId: string) => void;
  onOpenQuiet?: () => void;
  onOpenItem: (repo: string, number: number) => void;
}) {
  const { github, agents, system, comms } = snapshot;

  // people blocked on him — outranks his own work; review lane = external PRs awaiting his review
  const orgQueue = github.orgQueue.filter((it) => !isMuted(snapshot, 'github-item', it.id));
  // quiet = archive: muted items are GONE; the panel chip carries the hidden count.
  // orgQueue outranks actNow — drop items that also sit in the org queue so they show once
  const orgIds = new Set(github.orgQueue.map((it) => it.id));
  const actNow = github.actNow.filter((it) => !isMuted(snapshot, 'github-item', it.id) && !orgIds.has(it.id));
  const actNowHidden = github.actNow.filter((it) => !orgIds.has(it.id)).length - actNow.length;
  const orgReview = orgQueue.filter((it) => it.lane === 'review');
  const working = agents.agents.filter((a) => a.status === 'active' || a.status === 'running');
  const ticker = agents.activity.slice(-14).reverse();
  const gpuPct = system.gpu ? system.gpu.utilPct : null;
  // same cell set as the percent row above (gpu always present) so the two
  // justify-between rows keep their label columns vertically aligned
  const sparkCells: Array<{ key: 'cpu' | 'mem' | 'swap' | 'gpu'; pct: number | null }> = [
    { key: 'cpu', pct: system.cpu.pct },
    { key: 'mem', pct: system.mem.usedPct },
    { key: 'swap', pct: system.swap.usedPct },
    { key: 'gpu', pct: gpuPct },
  ];

  return (
    <div className="grid grid-cols-12 gap-5">
      {/* hero strip — serif numerals, every stat navigates */}
      <section
        className="glass rise col-span-12 flex flex-wrap items-end gap-x-10 gap-y-4 px-6 py-5 lg:gap-x-14"
        style={{ '--rise-i': 0 } as CSSProperties}
      >
        <Stat
          value={orgReview.length}
          label="waiting"
          accent={orgReview.length > 0}
          onClick={() => onNavigate('tasks')}
        />
        <Stat value={actNow.length} label="act now" accent={actNow.length > 0} onClick={() => onNavigate('tasks')} />
        <Stat value={comms.email.unreadCount} label="unread" onClick={() => onNavigate('comms')} />
        <Stat value={comms.calendar.today.length} label="today" onClick={() => onNavigate('comms')} />
        <Stat value={working.length} label="agents" onClick={() => onNavigate('agents')} />
      </section>

      {/* left column — act now + activity ticker (the ticker fills the space under a
          short act-now list and stays above the fold, mirroring the right column) */}
      <div className="col-span-12 flex flex-col gap-5 lg:col-span-7 xl:col-span-8">
        <Panel
          title="act now"
          riseIndex={1}
          right={<RelTime iso={github.updatedAt} />}
          quietCount={actNowHidden}
          onQuietClick={onOpenQuiet}
        >
          {github.error && (
            <div className="mb-2 truncate px-2.5 font-mono text-xs text-coral" title={github.error}>
              {github.error}
            </div>
          )}
          {actNow.length === 0 ? (
            <EmptyState>
              <span className="flex items-center gap-2">
                <Dot status="running" />
                <span className="text-jade">clear</span>
                <span>— nothing needs you</span>
              </span>
            </EmptyState>
          ) : (
            <div className="max-h-[26rem] space-y-0.5 overflow-y-auto">
              {actNow.slice(0, 12).map((it) => (
                <Row key={it.id} onClick={() => onOpenItem(it.repo, it.number)} title={it.title}>
                  <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />
                  <span className="w-36 shrink-0 truncate font-mono text-xs text-mist-faint xl:w-44">{it.repo}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-mist">{it.title}</span>
                  <RelTime iso={it.updatedAt} />
                  <span className="flex shrink-0 items-center gap-1">
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="open on github"
                      className="hover-cluster shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-slate-glow"
                    >
                      github
                    </a>
                    <SendToEigen
                      title={it.title}
                      url={it.url}
                      repo={it.repo}
                      sourceId={it.id}
                      dispatches={agents.dispatches}
                    />
                    <MuteButton kind="github-item" target={it.id} />
                    <MuteButton kind="github-repo" target={it.repo} label="repo" className="opacity-60" />
                  </span>
                </Row>
              ))}
            </div>
          )}
        </Panel>

        {/* activity ticker */}
        <Panel title="activity" riseIndex={6}>
          {ticker.length === 0 ? (
            <EmptyState>nothing happening</EmptyState>
          ) : (
            <div className="px-2.5 font-mono text-xs">
              {ticker.map((a, i) => (
                <div key={`${a.time}-${i}`} className="flex items-baseline gap-2 py-0.5">
                  {/* dot slot is always rendered so error lines don't shift the columns */}
                  <span
                    className={`h-1 w-1 shrink-0 self-center rounded-full ${a.isError ? 'bg-coral' : 'bg-transparent'}`}
                  />
                  <span className="shrink-0 tabular-nums text-mist-faint">{hhmmss(a.time)}</span>
                  <span className="w-24 shrink-0 truncate text-mist-dim sm:w-32" title={a.source}>
                    {a.source}
                  </span>
                  <span className="min-w-0 truncate text-mist-dim" title={a.text}>
                    {a.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* right column */}
      <div className="col-span-12 flex flex-col gap-5 lg:col-span-5 xl:col-span-4">
        {orgQueue.length > 0 && (
          <Panel title="waiting on you" riseIndex={2}>
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              {orgReview.slice(0, 5).map((it) => (
                <Row key={it.id} onClick={() => onOpenItem(it.repo, it.number)} title={it.title}>
                  <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />
                  <span className="shrink-0 whitespace-nowrap rounded border hairline px-1.5 py-px font-mono text-[10px] text-mist-faint">
                    {it.scope}
                  </span>
                  <span className="w-24 shrink-0 truncate font-mono text-xs text-mist-faint">{it.repo}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-mist">{it.title}</span>
                  <span className="hidden shrink-0 whitespace-nowrap font-mono text-[11px] text-mist-faint sm:inline">
                    @{it.author}
                  </span>
                  <RelTime iso={it.updatedAt} />
                </Row>
              ))}
            </div>
          </Panel>
        )}

        <Panel title="today" riseIndex={3} right={<NextEventCountdown events={comms.calendar.today} />}>
          {comms.calendar.today.length === 0 ? (
            <EmptyState>no events today</EmptyState>
          ) : (
            <div className="max-h-44 space-y-0.5 overflow-y-auto">
              {comms.calendar.today.map((ev) => (
                <Row key={ev.id} onClick={() => onNavigate('comms')} title={ev.title}>
                  <span className="w-14 shrink-0 font-mono text-xs tabular-nums text-mist-dim">
                    {ev.allDay ? 'all day' : hhmm(ev.start)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-mist">{ev.title}</span>
                </Row>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="agents working" riseIndex={4}>
          {working.length === 0 ? (
            <EmptyState>all quiet</EmptyState>
          ) : (
            <div className="space-y-0.5">
              {working.map((a) => (
                <Row key={a.id} onClick={() => onNavigate('agents')} title={a.detail}>
                  <Dot status={a.status} />
                  <span className="shrink-0 text-sm text-mist">{a.name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-mist-dim">{a.detail}</span>
                </Row>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="system" riseIndex={5}>
          <Row onClick={() => onNavigate('system')} className="justify-between font-mono text-sm tabular-nums">
            <span>
              <span className="text-[11px] text-mist-faint">cpu </span>
              <span className={pctClass(system.cpu.pct)}>{Math.round(system.cpu.pct)}%</span>
            </span>
            <span>
              <span className="text-[11px] text-mist-faint">mem </span>
              <span className={pctClass(system.mem.usedPct)}>{Math.round(system.mem.usedPct)}%</span>
            </span>
            <span>
              <span className="text-[11px] text-mist-faint">swap </span>
              <span className={pctClass(system.swap.usedPct)}>{Math.round(system.swap.usedPct)}%</span>
            </span>
            <span>
              <span className="text-[11px] text-mist-faint">gpu </span>
              {gpuPct === null ? (
                <span className="text-mist-faint">—</span>
              ) : (
                <span className={pctClass(gpuPct)}>{Math.round(gpuPct)}%</span>
              )}
            </span>
          </Row>
          {/* quiet sparkline strip — texture, not a chart. Buffers reset on reload,
              so the whole strip waits for 2+ samples instead of rendering bare labels */}
          {getSeries('cpu').length >= 2 && (
            <div className="mt-1 flex items-end justify-between gap-3 px-2.5 font-mono text-[10px] text-mist-faint">
              {sparkCells.map(({ key, pct }) => (
                <span key={key} className="flex min-w-0 items-end gap-1.5">
                  <span>{key}</span>
                  {pct === null || getSeries(key).length < 2 ? (
                    <span>—</span>
                  ) : (
                    <Spark series={getSeries(key)} className={pctTone(pct)} />
                  )}
                </span>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
