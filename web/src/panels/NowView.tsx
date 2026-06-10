import type { CSSProperties } from 'react';
import { isMuted } from '../api';
import { Dot, EmptyState, MuteButton, Panel, RelTime, Row, SendToEigen } from '../components/ui';
import type { Snapshot } from '../../../shared/types';

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
  return (
    <button onClick={onClick} className="group flex cursor-pointer flex-col items-start rounded-lg px-2 text-left">
      <span
        className={`font-display text-5xl italic leading-none tabular-nums xl:text-6xl ${accent ? 'text-amber' : 'text-mist'}`}
      >
        {value}
      </span>
      <span className="mt-2 font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint transition-colors group-hover:text-mist-dim">
        {label}
      </span>
    </button>
  );
}

export default function NowView({
  snapshot,
  onNavigate,
  onOpenQuiet,
}: {
  snapshot: Snapshot;
  onNavigate: (viewId: string) => void;
  onOpenQuiet?: () => void;
}) {
  const { github, agents, system, comms } = snapshot;

  // quiet = archive: muted items are GONE; the panel chip carries the hidden count
  const actNow = github.actNow.filter((it) => !isMuted(snapshot, 'github-repo', it.repo));
  const actNowHidden = github.actNow.length - actNow.length;
  const working = agents.agents.filter((a) => a.status === 'active' || a.status === 'running');
  const ticker = agents.activity.slice(-14).reverse();
  const gpuPct = system.gpu ? system.gpu.utilPct : null;

  return (
    <div className="grid grid-cols-12 gap-5">
      {/* hero strip — serif numerals, every stat navigates */}
      <section
        className="glass rise col-span-12 flex flex-wrap items-end gap-x-10 gap-y-4 px-6 py-5 lg:gap-x-14"
        style={{ '--rise-i': 0 } as CSSProperties}
      >
        <Stat value={actNow.length} label="act now" accent={actNow.length > 0} onClick={() => onNavigate('tasks')} />
        <Stat value={comms.email.unreadCount} label="unread" onClick={() => onNavigate('comms')} />
        <Stat value={comms.calendar.today.length} label="today" onClick={() => onNavigate('comms')} />
        <Stat value={working.length} label="agents" onClick={() => onNavigate('agents')} />
      </section>

      {/* act now */}
      <Panel
        title="act now"
        riseIndex={1}
        className="col-span-12 lg:col-span-7 xl:col-span-8"
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
              <Row key={it.id} href={it.url} title={it.title}>
                <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />
                <span className="w-36 shrink-0 truncate font-mono text-xs text-mist-faint xl:w-44">{it.repo}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-mist">{it.title}</span>
                <RelTime iso={it.updatedAt} />
                <span className="flex shrink-0 items-center gap-1">
                  <SendToEigen
                    title={it.title}
                    url={it.url}
                    repo={it.repo}
                    sourceId={it.id}
                    dispatches={agents.dispatches}
                  />
                  <MuteButton kind="github-repo" target={it.repo} />
                </span>
              </Row>
            ))}
          </div>
        )}
      </Panel>

      {/* right column */}
      <div className="col-span-12 flex flex-col gap-5 lg:col-span-5 xl:col-span-4">
        <Panel title="today" riseIndex={2}>
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

        <Panel title="agents working" riseIndex={3}>
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

        <Panel title="system" riseIndex={4}>
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
        </Panel>
      </div>

      {/* activity ticker */}
      <Panel title="activity" riseIndex={5} className="col-span-12">
        {ticker.length === 0 ? (
          <EmptyState>nothing happening</EmptyState>
        ) : (
          <div className="px-2.5 font-mono text-xs">
            {ticker.map((a, i) => (
              <div key={`${a.time}-${i}`} className="flex items-baseline gap-2 py-0.5">
                <span className="shrink-0 tabular-nums text-mist-faint">{hhmmss(a.time)}</span>
                <span className="shrink-0 text-mist-dim">{a.source}</span>
                <span className={`min-w-0 truncate ${a.isError ? 'text-coral' : 'text-mist-dim'}`} title={a.text}>
                  {a.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
