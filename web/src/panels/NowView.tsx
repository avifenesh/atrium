import type { CSSProperties } from 'react';
import { isMuted } from '../api';
import { Dot, EmptyState, MuteButton, Mutable, Panel, RelTime, SectionLabel } from '../components/ui';
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
    <button onClick={onClick} className="flex flex-col items-start px-2 text-left">
      <span
        className={`font-display text-5xl italic leading-none ${accent ? 'text-amber' : 'text-mist'}`}
      >
        {value}
      </span>
      <span className="mt-2 font-mono text-[11px] uppercase tracking-widest text-mist-faint transition-colors hover:text-mist-dim">
        {label}
      </span>
    </button>
  );
}

export default function NowView({
  snapshot,
  onNavigate,
}: {
  snapshot: Snapshot;
  onNavigate: (viewId: string) => void;
}) {
  const { github, agents, system, comms } = snapshot;

  // muted items stay in the list (Mutable dims them — DESIGN rule 5); only the hero count excludes them
  const actNowCount = github.actNow.filter((it) => !isMuted(snapshot, 'github-repo', it.repo)).length;
  const actNow = github.actNow.slice(0, 8);
  const working = agents.agents.filter((a) => a.status === 'active' || a.status === 'running');
  const ticker = agents.activity.slice(-12).reverse();
  const gpuPct = system.gpu ? system.gpu.utilPct : null;

  return (
    <div className="grid grid-cols-12 gap-5">
      {/* hero strip */}
      <section
        className="glass rise col-span-12 flex items-end gap-10 px-6 py-5"
        style={{ '--rise-i': 0 } as CSSProperties}
      >
        <Stat value={actNowCount} label="act now" accent={actNowCount > 0} onClick={() => onNavigate('tasks')} />
        <Stat value={comms.email.unreadCount} label="unread" onClick={() => onNavigate('comms')} />
        <Stat value={comms.calendar.today.length} label="today" onClick={() => onNavigate('comms')} />
        <Stat value={working.length} label="agents" onClick={() => onNavigate('agents')} />
      </section>

      {/* act now */}
      <Panel title="act now" riseIndex={1} className="col-span-7" right={<RelTime iso={github.updatedAt} />}>
        {github.error && <div className="mb-2 truncate font-mono text-xs text-coral">{github.error}</div>}
        {actNow.length === 0 ? (
          <EmptyState>
            <span className="flex items-center gap-2">
              <Dot status="running" />
              <span className="text-jade">clear</span>
              <span>— nothing needs you</span>
            </span>
          </EmptyState>
        ) : (
          <div className="space-y-0.5">
            {actNow.map((it) => (
              <Mutable key={it.id} snapshot={snapshot} kind="github-repo" target={it.repo}>
                <div className="group flex items-center gap-3 border-l border-l-amber/70 py-1.5 pl-3">
                  <span className="w-40 shrink-0 truncate font-mono text-xs text-mist-faint">{it.repo}</span>
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-sm text-mist hover:text-slate-glow"
                  >
                    {it.title}
                  </a>
                  <RelTime iso={it.updatedAt} />
                  <MuteButton kind="github-repo" target={it.repo} />
                </div>
              </Mutable>
            ))}
          </div>
        )}
      </Panel>

      {/* right column */}
      <div className="col-span-5 flex flex-col gap-5">
        <Panel title="today" riseIndex={2}>
          {comms.calendar.today.length === 0 ? (
            <EmptyState>no events today</EmptyState>
          ) : (
            <div className="max-h-44 overflow-y-auto">
              {comms.calendar.today.map((ev) => (
                <div key={ev.id} className="flex items-baseline gap-3 py-1.5">
                  <span className="w-14 shrink-0 font-mono text-xs text-mist-dim">
                    {ev.allDay ? 'all day' : hhmm(ev.start)}
                  </span>
                  <span className="min-w-0 truncate text-sm text-mist">{ev.title}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="agents working" riseIndex={3}>
          {working.length === 0 ? (
            <EmptyState>all quiet</EmptyState>
          ) : (
            <div>
              {working.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onNavigate('agents')}
                  className="flex w-full items-center gap-2 py-1.5 text-left"
                >
                  <Dot status={a.status} />
                  <span className="shrink-0 text-sm text-mist">{a.name}</span>
                  <span className="min-w-0 truncate text-xs text-mist-dim">{a.detail}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="system" riseIndex={4}>
          <button
            onClick={() => onNavigate('system')}
            className="flex w-full items-baseline justify-between font-mono text-sm"
          >
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
          </button>
        </Panel>
      </div>

      {/* activity ticker */}
      <Panel riseIndex={5} className="col-span-12">
        <SectionLabel>activity</SectionLabel>
        {ticker.length === 0 ? (
          <EmptyState>nothing happening</EmptyState>
        ) : (
          <div className="font-mono text-xs">
            {ticker.map((a, i) => (
              <div key={`${a.time}-${i}`} className="flex items-baseline gap-2 py-0.5">
                <span className="shrink-0 text-mist-faint">{hhmmss(a.time)}</span>
                <span className="shrink-0 text-mist-dim">{a.source}</span>
                <span className={`min-w-0 truncate ${a.isError ? 'text-coral' : 'text-mist-dim'}`}>
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
