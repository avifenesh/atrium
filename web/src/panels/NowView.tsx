import type { CSSProperties } from 'react';
import { isMuted } from '../api';
import { Dot, EmptyState, MuteButton, Panel, RelTime, Row, SendToEigen } from '../components/ui';
import Spark from '../components/Spark';
import { getSeries, pctTone, useFirstSeen, useNow, useTweenNumber } from '../hooks';
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
  tone,
  onClick,
}: {
  value: number;
  label: string;
  /** semantic color when value > 0 (amber = attention, jade = live/healthy);
   *  omitted = neutral mist. zero always de-emphasizes to faint. */
  tone?: 'amber' | 'jade';
  onClick: () => void;
}) {
  const display = useTweenNumber(value);
  // Instrument Serif has no tnum feature (digits are proportional), so the glide
  // would reflow the whole hero strip every frame — reserve a stable slot instead:
  // min-width in ch (the '0' advance, the font's widest digit) per target digit
  const digits = String(Math.abs(Math.round(value))).length;
  // zero de-emphasis keys off the real value, not the tween, so it never flickers mid-glide
  return (
    <button onClick={onClick} className="group flex min-w-[6.5rem] cursor-pointer flex-col items-start px-2 py-1 text-left">
      <span
        style={{ minWidth: `${digits}ch` }}
        className={`inline-block font-display text-5xl italic leading-none tracking-[-0.04em] xl:text-6xl ${value === 0 ? 'text-mist-faint' : tone === 'amber' ? 'text-amber' : tone === 'jade' ? 'text-jade' : 'text-mist'}`}
      >
        {display}
      </span>
      <span className="mt-2 text-xs font-medium text-mist-faint transition-colors group-hover:text-mist-dim">
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
  const freshIds = useFirstSeen([...actNow.map((it) => it.id), ...orgReview.map((it) => it.id)]);
  const working = agents.agents.filter((a) => a.status === 'active' || a.status === 'running');
  // Now shows a per-source *summary* of live activity (latest event + volume),
  // not the raw feed — the full feed lives on the Agents view. Collapses a wall
  // of identical `eigen · reasoning` lines into one honest "eigen ×N" row.
  const activityBySource = new Map<string, { last: (typeof agents.activity)[number]; count: number }>();
  for (const a of agents.activity) {
    const e = activityBySource.get(a.source);
    if (e) {
      e.last = a;
      e.count += 1;
    } else activityBySource.set(a.source, { last: a, count: 1 });
  }
  const ticker = [...activityBySource.values()]
    .sort((x, y) => y.last.time.localeCompare(x.last.time))
    .slice(0, 6);
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
        className="stat-band rise col-span-12 flex flex-wrap items-end gap-x-8 gap-y-4 px-6 py-6 lg:gap-x-12"
        style={{ '--rise-i': 0 } as CSSProperties}
      >
        <Stat
          value={orgReview.length}
          label="Waiting on me"
          tone={orgReview.length > 0 ? 'amber' : undefined}
          onClick={() => onNavigate('tasks')}
        />
        <Stat
          value={actNow.length}
          label="Needs action"
          tone={actNow.length > 0 ? 'amber' : undefined}
          onClick={() => onNavigate('tasks')}
        />
        <Stat value={comms.email.unreadCount} label="Unread mail" onClick={() => onNavigate('comms')} />
        <Stat value={comms.calendar.today.length} label="Events today" onClick={() => onNavigate('comms')} />
        <Stat
          value={working.length}
          label="Agents working"
          tone={working.length > 0 ? 'jade' : undefined}
          onClick={() => onNavigate('agents')}
        />
      </section>

      {/* left column — act now + activity ticker (the ticker fills the space under a
          short act-now list and stays above the fold, mirroring the right column) */}
      <div className="col-span-12 flex flex-col gap-5 lg:col-span-7 xl:col-span-8">
        <Panel
          title="Needs action"
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
                <span className="text-jade">All clear.</span>
                <span>Nothing needs your attention.</span>
              </span>
            </EmptyState>
          ) : (
            <div className="max-h-[26rem] space-y-0.5 overflow-y-auto">
              {actNow.slice(0, 12).map((it) => (
                <Row
                  key={it.id}
                  onClick={() => onOpenItem(it.repo, it.number)}
                  title={it.title}
                  className="flex-wrap sm:flex-nowrap"
                >
                  <span className="w-1.5 shrink-0 self-center" aria-hidden="true">
                    {freshIds.has(it.id) && <span className="block h-1.5 w-1.5 rounded-full bg-amber" />}
                  </span>
                  <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />
                  <span className="w-24 shrink-0 truncate font-mono text-xs text-mist-faint sm:w-36 2xl:w-44">{it.repo}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-mist">{it.title}</span>
                  <RelTime iso={it.updatedAt} />
                  <span className="row-actions mobile-row-actions">
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
                    <MuteButton kind="github-item" target={it.id} untilActivity />
                    <MuteButton kind="github-repo" target={it.repo} label="repo" className="opacity-60" />
                  </span>
                </Row>
              ))}
            </div>
          )}
        </Panel>

        {/* live activity — per-source summary; the raw feed is on the Agents view */}
        <Panel title="Live activity" riseIndex={6}>
          {agents.activity.length === 0 ? (
            <EmptyState>No recent agent activity.</EmptyState>
          ) : (
            <div className="activity-rail px-2.5 font-mono text-xs">
              {ticker.map(({ last, count }) => (
                <div key={last.source} className="flex items-baseline gap-2 py-0.5">
                  {/* dot slot is always rendered so error lines don't shift the columns */}
                  <span
                    className={`h-1 w-1 shrink-0 self-center rounded-full ${last.isError ? 'bg-coral' : 'bg-transparent'}`}
                  />
                  <span className="shrink-0 tabular-nums text-mist-faint">{hhmmss(last.time)}</span>
                  <span className="w-24 shrink-0 truncate text-mist-dim sm:w-32" title={last.source}>
                    {last.source}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-mist-dim" title={last.text}>
                    {last.text}
                  </span>
                  {count > 1 && (
                    <span className="shrink-0 tabular-nums text-mist-faint" title={`${count} events`}>
                      ×{count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* right column */}
      <div className="col-span-12 flex flex-col gap-5 lg:col-span-5 xl:col-span-4">
        {orgQueue.length > 0 && (
          <Panel title="Waiting on you" riseIndex={2}>
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              {orgReview.slice(0, 5).map((it) => (
                <Row key={it.id} onClick={() => onOpenItem(it.repo, it.number)} title={it.title}>
                  <span className="w-1.5 shrink-0 self-center" aria-hidden="true">
                    {freshIds.has(it.id) && <span className="block h-1.5 w-1.5 rounded-full bg-amber" />}
                  </span>
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

        {/* secondary surface: omit entirely when empty (calm by default) — the
            primary "Needs action" panel keeps its reassuring empty state */}
        {comms.calendar.today.length > 0 && (
          <Panel title="Today" riseIndex={3} right={<NextEventCountdown events={comms.calendar.today} />}>
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
          </Panel>
        )}

        <Panel title="Agents working" riseIndex={4}>
          {working.length === 0 ? (
            <EmptyState>No agents are working right now.</EmptyState>
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

        <Panel title="Machine load" riseIndex={5}>
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
