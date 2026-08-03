import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { isAgentWorking } from '../agentWork';
import { agentAction, isMuted } from '../api';
import {
  CopyText,
  Dot,
  EmptyState,
  MuteButton,
  Panel,
  QuietChip,
  RelTime,
  Row,
  SectionLabel,
} from '../components/ui';
import type {
  AgentControl,
  AgentInfo,
  AgentSession,
  EigenDispatch,
  Snapshot,
} from '../../../shared/types';

function sessionLabel(s: AgentSession): string {
  if (s.title) return s.title;
  if (s.dir) return s.dir.split('/').filter(Boolean).pop() ?? s.dir;
  return s.id;
}

function controlKey(c: AgentControl): string {
  return `${c.action}|${c.target ?? ''}`;
}

/** EigenDispatch.status → .dot-* class: running pulses amber, done is jade, error coral. */
function dispatchDot(status: EigenDispatch['status']): string {
  return status === 'running' ? 'active' : status === 'done' ? 'running' : 'error';
}

function DispatchRow({ d }: { d: EigenDispatch }) {
  return (
    <Row className="group">
      <div className="flex w-full min-w-0 items-center gap-2">
        <Dot status={dispatchDot(d.status)} />
        <div className="min-w-0 flex-1 overflow-hidden">
          <CopyText text={d.title}>
            <span className="block truncate text-sm text-mist" title={d.title}>
              {d.title}
            </span>
          </CopyText>
        </div>
        <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-dim">
          {d.mode}
        </span>
        <RelTime iso={d.startedAt} />
        {d.logPath && (
          <CopyText text={d.logPath} className="hover-cluster shrink-0">
            <span className="shrink-0 font-mono text-[10px] text-mist-faint" title={d.logPath}>
              log
            </span>
          </CopyText>
        )}
      </div>
    </Row>
  );
}

function AgentCard({
  agent,
  snapshot,
  riseIndex,
  dispatches,
  onOpenQuiet,
}: {
  agent: AgentInfo;
  snapshot: Snapshot;
  riseIndex: number;
  dispatches: EigenDispatch[];
  onOpenQuiet: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // '<repo>' / '<jobId>' style targets are placeholders — collect the concrete one
  // with an inline in-card input (DESIGN v2: never a native blocking dialog)
  const [pending, setPending] = useState<{ c: AgentControl; value: string } | null>(null);
  const [result, setResult] = useState<{ text: string; isError: boolean } | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resultTimer.current) clearTimeout(resultTimer.current);
    },
    [],
  );

  const run = async (c: AgentControl, target: string | undefined) => {
    const key = controlKey(c);
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

  const fire = async (c: AgentControl) => {
    const key = controlKey(c);
    // two-click confirm for destructive actions: first click arms, second fires
    if (c.destructive && armed !== key) {
      setArmed(key);
      setTimeout(() => setArmed((a) => (a === key ? null : a)), 4000);
      return;
    }
    setArmed(null);
    if (c.target && /^<.+>$/.test(c.target)) {
      setPending({ c, value: '' });
      return;
    }
    await run(c, c.target);
  };

  // muted resources disappear entirely — the drawer is their archive
  const visibleResources = agent.resources.filter(
    (r) => !isMuted(snapshot, 'agent-resource', `${agent.id}:${r.id}`),
  );
  const quietResources = agent.resources.length - visibleResources.length;

  const sessions = agent.sessions.slice(0, 5);
  const moreSessions = agent.sessions.length - sessions.length;
  const recentDispatches =
    agent.id === 'eigen'
      ? [...dispatches].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 8)
      : [];

  return (
    <section
      className="panel-surface rise flex h-full min-w-0 flex-col p-4"
      style={{ '--rise-i': riseIndex } as CSSProperties}
    >
      <Row onClick={() => setExpanded((o) => !o)}>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
          <Dot status={agent.status} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold lowercase text-mist">
            {agent.name}
          </span>
          <span className="shrink-0 font-mono text-xs text-mist-faint">{agent.status}</span>
          <RelTime iso={agent.lastActivity} />
          <span className="shrink-0 font-mono text-[10px] text-mist-faint">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="mobile-row-actions flex shrink-0 items-center justify-end gap-1 sm:ml-auto sm:basis-auto">
            {quietResources > 0 && (
              <span onClick={(e) => e.stopPropagation()}>
                <QuietChip count={quietResources} onClick={onOpenQuiet} />
              </span>
            )}
            <MuteButton kind="agent" target={agent.id} enforce />
          </span>
        </div>
      </Row>
      {agent.error && (
        <div className="mt-1 truncate font-mono text-xs text-coral" title={agent.error}>
          {agent.error}
        </div>
      )}
      <div className="mt-1 truncate text-sm text-mist-dim" title={agent.detail}>
        {agent.detail}
      </div>

      {recentDispatches.length > 0 && (
        <>
          <SectionLabel>
            dispatches <span className="tabular-nums">· {recentDispatches.length}</span>
          </SectionLabel>
          <div className="max-h-48 overflow-y-auto">
            {recentDispatches.map((d) => (
              <DispatchRow key={d.id} d={d} />
            ))}
          </div>
        </>
      )}

      {expanded && (
        <>
          {agent.sessions.length > 0 && (
            <>
              <SectionLabel>
                sessions <span className="tabular-nums">· {agent.sessions.length}</span>
              </SectionLabel>
              <div>
                {sessions.map((s) => (
                  <Row key={s.id} className="group">
                    <div className="flex w-full min-w-0 items-center gap-2">
                      <Dot status={s.live ? 'running' : 'off'} />
                      {s.dir ? (
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <CopyText text={s.dir}>
                            <span className="block truncate text-left text-sm text-mist" title={s.dir}>
                              {sessionLabel(s)}
                            </span>
                          </CopyText>
                        </div>
                      ) : (
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <CopyText text={s.id}>
                            <span className="block truncate text-left text-sm text-mist" title={s.id}>
                              {sessionLabel(s)}
                            </span>
                          </CopyText>
                        </div>
                      )}
                      {s.model && (
                        <span className="shrink-0 font-mono text-xs text-mist-faint">{s.model}</span>
                      )}
                      <RelTime iso={s.updatedAt} />
                    </div>
                  </Row>
                ))}
                {moreSessions > 0 && (
                  <div className="py-1 font-mono text-[11px] tabular-nums text-mist-faint">
                    {moreSessions} more
                  </div>
                )}
              </div>
            </>
          )}

          {visibleResources.length > 0 && (
            <>
              <SectionLabel>
                resources <span className="tabular-nums">· {visibleResources.length}</span>
              </SectionLabel>
              <div className="max-h-44 overflow-y-auto">
                {visibleResources.map((r) => {
                  const target = `${agent.id}:${r.id}`;
                  // hermes cron resources report 'enabled', not 'active' — only known-stopped states are inactive
                  const isActive = r.state !== 'paused' && r.state !== 'off';
                  return (
                    <Row key={r.id} className="group">
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <Dot status={isActive ? 'running' : 'off'} />
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <CopyText text={r.id}>
                            <span className="block truncate text-left text-sm text-mist" title={r.name}>
                              {r.name}
                            </span>
                          </CopyText>
                        </div>
                        {r.muteable && <MuteButton kind="agent-resource" target={target} enforce />}
                        <span className="shrink-0 font-mono text-[11px] text-mist-faint">
                          {r.state}
                        </span>
                      </div>
                    </Row>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {expanded && agent.controls.length > 0 && (
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
                    c.destructive ? 'text-coral hover:text-coral' : 'text-mist-dim hover:text-mist'
                  }`}
                >
                  {isBusy ? '◌' : isArmed ? 'sure?' : c.label}
                </button>
              );
            })}
          </div>
          {pending && (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const target = pending.value.trim();
                if (!target) return;
                setPending(null);
                void run(pending.c, target);
              }}
            >
              <span className="shrink-0 font-mono text-[11px] text-mist-dim">{pending.c.label}</span>
              <input
                autoFocus
                value={pending.value}
                onChange={(e) => setPending((p) => (p ? { ...p, value: e.target.value } : p))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setPending(null);
                }}
                placeholder={pending.c.target!.slice(1, -1)}
                className="glass min-w-0 flex-1 rounded-md px-2 py-1 font-mono text-[11px] text-mist outline-none placeholder:text-mist-faint"
              />
              <button
                type="submit"
                className="shrink-0 cursor-pointer rounded-md px-2 py-1 font-mono text-[11px] text-jade transition-colors glass hover:text-mist"
              >
                go
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="shrink-0 cursor-pointer rounded-md px-2 py-1 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
              >
                cancel
              </button>
            </form>
          )}
          {result && (
            <div
              className={`mt-2 truncate font-mono text-xs ${result.isError ? 'text-coral' : 'text-mist-faint'}`}
              title={result.text}
            >
              {result.text}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function AgentsPanel({
  snapshot,
  onOpenQuiet: openQuiet,
}: {
  snapshot: Snapshot;
  onOpenQuiet: () => void;
}) {
  const { agents, activity } = snapshot.agents;
  const dispatches = snapshot.agents.dispatches ?? [];

  // muted agents disappear from the grid — quiet chip is the way back (drawer = archive)
  const visible = agents.filter((a) => !isMuted(snapshot, 'agent', a.id));
  const quietAgents = agents.length - visible.length;
  // working agents first, then errors, then calm daemons
  const ordered = [...visible].sort((a, b) => {
    const score = (x: AgentInfo) =>
      isAgentWorking(x, dispatches) ? 0 : x.status === 'error' ? 1 : x.status === 'running' ? 2 : 3;
    return score(a) - score(b) || a.name.localeCompare(b.name);
  });

  return (
    <div>
      {quietAgents > 0 && (
        <div className="mb-3 flex justify-end">
          <QuietChip count={quietAgents} onClick={openQuiet} />
        </div>
      )}

      {ordered.length === 0 ? (
        <Panel title="Agent status" quietCount={quietAgents || undefined} onQuietClick={openQuiet}>
          <EmptyState>No agents are reporting.</EmptyState>
        </Panel>
      ) : (
        <div className="grid items-stretch gap-4 xl:grid-cols-2 2xl:grid-cols-3">
          {ordered.map((a, i) => (
            <AgentCard
              key={a.id}
              agent={a}
              snapshot={snapshot}
              riseIndex={i}
              dispatches={dispatches}
              onOpenQuiet={openQuiet}
            />
          ))}
        </div>
      )}

      <Panel
        title="Recent activity"
        riseIndex={visible.length}
        className="mt-4"
        right={
          activity.length > 0 ? (
            <span className="font-mono text-xs tabular-nums text-mist-faint">{activity.length}</span>
          ) : undefined
        }
      >
        {activity.length === 0 ? (
          <EmptyState>No recent agent activity.</EmptyState>
        ) : (
          <div className="max-h-48 overflow-y-auto font-mono text-xs">
            {/* server builds activity oldest-first (newest last) — show the newest 30, newest first */}
            {activity.slice(-30).reverse().map((a, i) => (
              <div key={`${a.time}-${i}`} className="flex items-baseline gap-2 py-0.5">
                {/* fixed time + source slots so the mono log reads as columns
                    ('29s' vs '1m' must not shift the source column) */}
                <span className="w-9 shrink-0 text-right">
                  <RelTime iso={a.time} />
                </span>
                <span className="w-24 shrink-0 truncate text-mist-faint" title={a.source}>
                  {a.source}
                </span>
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
