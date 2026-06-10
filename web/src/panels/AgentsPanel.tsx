import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { agentAction } from '../api';
import {
  Dot,
  EmptyState,
  MuteButton,
  Mutable,
  Panel,
  RelTime,
  SectionLabel,
  UnmuteButton,
} from '../components/ui';
import type { AgentControl, AgentInfo, AgentSession, Mute, Snapshot } from '../../../shared/types';

function activeMute(snapshot: Snapshot, kind: Mute['kind'], target: string): Mute | undefined {
  const now = Date.now();
  return snapshot.mutes.find(
    (m) => m.kind === kind && m.target === target && (!m.until || new Date(m.until).getTime() > now),
  );
}

function sessionLabel(s: AgentSession): string {
  if (s.title) return s.title;
  if (s.dir) return s.dir.split('/').filter(Boolean).pop() ?? s.dir;
  return s.id;
}

function controlKey(c: AgentControl): string {
  return `${c.action}|${c.target ?? ''}`;
}

function AgentCard({
  agent,
  snapshot,
  riseIndex,
}: {
  agent: AgentInfo;
  snapshot: Snapshot;
  riseIndex: number;
}) {
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; isError: boolean } | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resultTimer.current) clearTimeout(resultTimer.current);
    },
    [],
  );

  const fire = async (c: AgentControl) => {
    const key = controlKey(c);
    // two-click confirm for destructive actions: first click arms, second fires
    if (c.destructive && armed !== key) {
      setArmed(key);
      setTimeout(() => setArmed((a) => (a === key ? null : a)), 4000);
      return;
    }
    setArmed(null);
    // '<repo>' / '<jobId>' style targets are placeholders, not real resources — ask for the concrete one
    let target = c.target;
    if (target && /^<.+>$/.test(target)) {
      const entered = window.prompt(`${c.label} — enter ${target.slice(1, -1)}:`, '');
      if (!entered?.trim()) return;
      target = entered.trim();
    }
    setBusy(key);
    try {
      const res = await agentAction(agent.id, c.action, target);
      setResult({
        text: res.error ?? res.output ?? (res.ok ? 'ok' : 'failed'),
        isError: !res.ok || !!res.error,
      });
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setBusy(null);
      // key the clear timer to this result: a previous control's timer must not wipe a newer result
      if (resultTimer.current) clearTimeout(resultTimer.current);
      resultTimer.current = setTimeout(() => setResult(null), 8000);
    }
  };

  const sessions = agent.sessions.slice(0, 5);
  const moreSessions = agent.sessions.length - sessions.length;

  return (
    <Mutable snapshot={snapshot} kind="agent" target={agent.id}>
      <section className="glass rise flex h-full flex-col p-4" style={{ '--rise-i': riseIndex } as CSSProperties}>
        <header className="group flex items-center gap-2">
          <Dot status={agent.status} />
          <span className="font-display text-lg italic lowercase text-mist">{agent.name}</span>
          <span className="font-mono text-xs text-mist-faint">{agent.status}</span>
          <span className="flex-1" />
          <MuteButton kind="agent" target={agent.id} enforce />
          <RelTime iso={agent.lastActivity} />
        </header>
        {agent.error && <div className="mt-1 truncate font-mono text-xs text-coral">{agent.error}</div>}
        <div className="mt-1 text-sm text-mist-dim">{agent.detail}</div>

        {agent.sessions.length > 0 && (
          <>
            <SectionLabel>sessions</SectionLabel>
            <div>
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-1 text-sm">
                  <Dot status={s.live ? 'running' : 'off'} />
                  <span className="min-w-0 truncate text-mist">{sessionLabel(s)}</span>
                  {s.model && <span className="shrink-0 font-mono text-xs text-mist-faint">{s.model}</span>}
                  <span className="flex-1" />
                  <RelTime iso={s.updatedAt} />
                </div>
              ))}
              {moreSessions > 0 && (
                <div className="py-1 font-mono text-[11px] text-mist-faint">{moreSessions} more</div>
              )}
            </div>
          </>
        )}

        {agent.resources.length > 0 && (
          <>
            <button
              onClick={() => setResourcesOpen((o) => !o)}
              className="mb-1 mt-4 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-mist-faint transition-colors hover:text-mist-dim"
            >
              <span>{resourcesOpen ? '▾' : '▸'}</span>
              resources · {agent.resources.length}
            </button>
            {resourcesOpen && (
              <div className="max-h-44 overflow-y-auto">
                {agent.resources.map((r) => {
                  const target = `${agent.id}:${r.id}`;
                  // hermes cron resources report 'enabled', not 'active' — only known-stopped states are inactive
                  const isActive = r.state !== 'paused' && r.state !== 'off';
                  const mute = activeMute(snapshot, 'agent-resource', target);
                  if (!isActive) {
                    return (
                      <div key={r.id} className="muted-dim flex items-center gap-2 py-1 text-sm">
                        <Dot status="off" />
                        <span className="min-w-0 truncate text-mist">{r.name}</span>
                        <span className="flex-1" />
                        {mute ? (
                          <UnmuteButton id={mute.id} />
                        ) : (
                          <span className="font-mono text-[11px] text-mist-faint">{r.state}</span>
                        )}
                      </div>
                    );
                  }
                  // a ui-mode mute on an active resource still dims it (DESIGN rule 5) and offers unquiet inline
                  return (
                    <div key={r.id} className={`group flex items-center gap-2 py-1 text-sm ${mute ? 'muted-dim' : ''}`}>
                      <Dot status="running" />
                      <span className="min-w-0 truncate text-mist">{r.name}</span>
                      <span className="flex-1" />
                      {mute ? (
                        <UnmuteButton id={mute.id} />
                      ) : (
                        r.muteable && <MuteButton kind="agent-resource" target={target} enforce />
                      )}
                      <span className="font-mono text-[11px] text-mist-faint">{r.state}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {agent.controls.length > 0 && (
          <div className="mt-auto pt-3">
            <div className="flex flex-wrap gap-2">
              {agent.controls.map((c) => {
                const key = controlKey(c);
                const isArmed = armed === key;
                const isBusy = busy === key;
                return (
                  <button
                    key={key}
                    disabled={isBusy}
                    onClick={() => {
                      void fire(c);
                    }}
                    className={`rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
                      isArmed ? 'glass-raised text-coral' : 'glass'
                    } ${
                      c.destructive
                        ? 'text-coral hover:text-coral'
                        : 'text-mist-dim hover:text-mist'
                    }`}
                  >
                    {isBusy ? '◌' : isArmed ? 'sure?' : c.label}
                  </button>
                );
              })}
            </div>
            {result && (
              <div
                className={`mt-2 truncate font-mono text-xs ${result.isError ? 'text-coral' : 'text-mist-faint'}`}
              >
                {result.text}
              </div>
            )}
          </div>
        )}
      </section>
    </Mutable>
  );
}

export default function AgentsPanel({ snapshot }: { snapshot: Snapshot }) {
  const { agents, activity } = snapshot.agents;

  return (
    <div>
      {agents.length === 0 ? (
        <Panel title="agents">
          <EmptyState>no agents reporting</EmptyState>
        </Panel>
      ) : (
        <div className="grid items-stretch gap-4 xl:grid-cols-2">
          {agents.map((a, i) => (
            <AgentCard key={a.id} agent={a} snapshot={snapshot} riseIndex={i} />
          ))}
        </div>
      )}

      <Panel title="activity" riseIndex={agents.length} className="mt-4">
        {activity.length === 0 ? (
          <EmptyState>nothing happening</EmptyState>
        ) : (
          <div className="max-h-48 overflow-y-auto font-mono text-xs">
            {/* server builds activity oldest-first (newest last) — show the newest 30, newest first */}
            {activity.slice(-30).reverse().map((a, i) => (
              <div key={`${a.time}-${i}`} className="flex items-baseline gap-2 py-0.5">
                <RelTime iso={a.time} />
                <span className="shrink-0 text-mist-faint">{a.source}</span>
                <span className={`min-w-0 truncate ${a.isError ? 'text-coral' : 'text-mist-dim'}`}>{a.text}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
