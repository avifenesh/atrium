import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { archiveReentry, parkReentry, resumeReentry, scanReentry } from '../api';
import { Dot, EmptyState, Panel, RelTime } from '../components/ui';
import type { ReentryContext, ReentryEnergy, ReentryState, Snapshot } from '../../../shared/types';

const ENERGY: ReentryEnergy[] = ['light', 'medium', 'deep'];

function GitLine({ context }: { context: ReentryContext }) {
  const git = context.git;
  if (!git) return <span className="font-mono text-[11px] text-mist-faint">not a git worktree</span>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-mist-faint">
      <span>{git.branch ?? 'detached'}</span>
      <span className={git.dirty > 0 ? 'text-amber' : ''}>{git.dirty} changed</span>
      {git.ahead !== null && <span>↑{git.ahead}</span>}
      {git.behind !== null && <span>↓{git.behind}</span>}
      {git.lastCommitAt && (
        <span className="inline-flex items-center gap-1">
          commit <RelTime iso={git.lastCommitAt} />
        </span>
      )}
    </div>
  );
}

function ThreadStep({
  label,
  children,
  next = false,
}: {
  label: string;
  children: ReactNode;
  next?: boolean;
}) {
  return (
    <div className={`reentry-step ${next ? 'is-next' : ''}`}>
      <div className={`font-mono text-[10px] uppercase tracking-[0.17em] ${next ? 'text-amber' : 'text-mist-faint'}`}>
        {label}
      </div>
      <div className={`mt-1 text-sm leading-relaxed ${next ? 'font-medium text-mist' : 'text-mist-dim'}`}>{children}</div>
    </div>
  );
}

function ContextCard({
  context,
  busy,
  armed,
  onResume,
  onArchive,
}: {
  context: ReentryContext;
  busy: string | null;
  armed: boolean;
  onResume: () => void;
  onArchive: () => void;
}) {
  const capsule = context.capsule;
  const scanning = context.scanStatus === 'queued';
  return (
    <Panel
      rise={false}
      className="scroll-mt-6"
      right={
        <span className="inline-flex items-center gap-2 font-mono text-[10px]">
          <Dot status={context.scanStatus === 'error' ? 'error' : scanning ? 'active' : 'running'} />
          <span className={context.scanStatus === 'error' ? 'text-coral' : scanning ? 'text-amber' : 'text-mist-faint'}>
            {context.scanStatus === 'error' ? 'scan failed' : scanning ? 'preparing' : 'prepared'}
          </span>
        </span>
      }
    >
      <article id={`reentry-context-${context.id}`}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <h2 className="truncate text-base font-semibold tracking-[-0.015em] text-mist">{context.title}</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-mist-faint">{context.energy}</span>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-mist-faint" title={context.path}>
              {context.path}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-[10px] text-mist-faint">
              parked <RelTime iso={context.parkedAt} />
            </span>
            <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${context.state === 'active' ? 'bg-jade/10 text-jade' : 'bg-white/5 text-mist-faint'}`}>
              {context.state}
            </span>
          </div>
        </div>

        <div className="mt-3 border-y border-white/[0.055] py-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <GitLine context={context} />
            <span
              className="max-w-full truncate font-mono text-[10px] text-mist-faint"
              title="Resume opens Claude in this directory with the parked brief"
            >
              resumes: claude{context.resumeTarget.kind === 'claude' && context.resumeTarget.id ? ' · session' : ''}
            </span>
          </div>
        </div>

        {context.git?.summary.length ? (
          <details className="mt-3 rounded-lg border border-white/[0.055] bg-white/[0.018] px-3 py-2">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-mist-faint">
              captured worktree · {context.git.summary.length} lines
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-mist-dim">
              {context.git.summary.join('\n')}
            </pre>
          </details>
        ) : null}

        {context.note && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-mist-dim">{context.note}</p>}

        <div className="reentry-thread mt-5 space-y-4">
          <ThreadStep label="Next" next>
            {capsule?.nextAction ?? 'Run the status agent to prepare the next concrete action.'}
          </ThreadStep>
          <ThreadStep label="Goal">{capsule?.goal ?? (context.note || 'Awaiting an explicit goal.')}</ThreadStep>
          <ThreadStep label="Verified true">
            {capsule?.verifiedFacts.length ? (
              <ul className="space-y-1">
                {capsule.verifiedFacts.map((fact, index) => <li key={`${index}:${fact}`}>{fact}</li>)}
              </ul>
            ) : (
              'The status agent has not prepared verified facts yet.'
            )}
          </ThreadStep>
          {capsule?.rejectedPaths.length ? (
            <ThreadStep label="Ruled out">
              <ul className="space-y-1">
                {capsule.rejectedPaths.map((path, index) => <li key={`${index}:${path}`}>{path}</li>)}
              </ul>
            </ThreadStep>
          ) : null}
          <ThreadStep label="Blocker">
            {capsule ? capsule.blocker ?? 'No explicit blocker appears in the evidence.' : 'Not assessed yet.'}
          </ThreadStep>
        </div>

        {context.scanError && <div className="mt-4 rounded-lg border border-coral/25 bg-coral/5 px-3 py-2 text-xs text-coral">{context.scanError}</div>}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.055] pt-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={onArchive}
            className={`min-h-9 cursor-pointer rounded-md px-3 py-1.5 font-mono text-[11px] transition-colors disabled:cursor-default disabled:opacity-50 ${armed ? 'bg-coral/10 text-coral' : 'text-mist-faint hover:bg-white/5 hover:text-mist'}`}
          >
            {armed ? 'mark done?' : 'done'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={onResume}
            className="min-h-9 cursor-pointer rounded-md bg-amber px-3 py-1.5 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            {busy === `resume:${context.id}` ? 'Opening…' : 'Resume in Claude'}
          </button>
        </div>
      </article>
    </Panel>
  );
}

function emptyReentry(): ReentryState {
  return {
    updatedAt: null,
    contexts: [],
    briefing: null,
    agent: { status: 'idle', model: '', lastCheckedAt: null, lastPreparedAt: null, lastError: null, nextRunAt: null },
    lastLaunch: null,
    error: null,
  };
}

export default function ReentryPanel({ snapshot }: { snapshot: Snapshot }) {
  const state = snapshot.reentry ?? emptyReentry();
  const active = state.contexts.filter((context) => context.state !== 'done');
  const done = state.contexts.filter((context) => context.state === 'done');
  const last = state.lastLaunch
    ? active.find((context) => context.id === state.lastLaunch?.contextId) ?? null
    : null;
  const repoOptions = useMemo(
    () => [...snapshot.repos.repos].sort((a, b) => a.name.localeCompare(b.name)),
    [snapshot.repos.repos],
  );
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [energy, setEnergy] = useState<ReentryEnergy>('medium');
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const focusItems = (state.briefing?.focus ?? []).filter(
    (item) => active.length !== 1 || item.contextId !== active[0]?.id,
  );

  const showFeedback = (text: string, error = false) => {
    setFeedback({ text, error });
    window.setTimeout(() => setFeedback((current) => (current?.text === text ? null : current)), 6_000);
  };

  const submitPark = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim() || busy) return;
    setBusy('park');
    try {
      const context = await parkReentry({ path: path.trim(), title, note, energy });
      setTitle('');
      setNote('');
      showFeedback(`${context.title} parked. Preparing its status now.`);
      await scanReentry().catch((err) => showFeedback(`Parked, but scan could not start: ${err instanceof Error ? err.message : String(err)}`, true));
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const resume = async (context: ReentryContext) => {
    setBusy(`resume:${context.id}`);
    try {
      const result = await resumeReentry(context.id);
      showFeedback(result.launched ? `Opened ${context.title} in ${result.via}.` : `Could not open a terminal: ${result.via}`, !result.launched);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const archive = async (context: ReentryContext) => {
    if (armed !== context.id) {
      setArmed(context.id);
      window.setTimeout(() => setArmed((current) => (current === context.id ? null : current)), 4_000);
      return;
    }
    setArmed(null);
    setBusy(`archive:${context.id}`);
    try {
      await archiveReentry(context.id);
      showFeedback(`${context.title} moved to done.`);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const scan = async () => {
    setBusy('scan');
    try {
      await scanReentry();
      showFeedback('Background status scan queued.');
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const focusItem = (contextId: string | null, focusPath: string | null) => {
    if (contextId) {
      document.getElementById(`reentry-context-${contextId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (focusPath) {
      setPath(focusPath);
      document.getElementById('reentry-park')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  return (
    <div className="space-y-5">
      {feedback && (
        <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${feedback.error ? 'border-coral/30 bg-coral/5 text-coral' : 'border-jade/25 bg-jade/5 text-jade'}`}>
          {feedback.text}
        </div>
      )}

      <section className="stat-band rise px-5 py-5 sm:px-6" style={{ '--rise-i': 0 } as CSSProperties}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mist-faint">
              {state.briefing ? `prepared by ${state.briefing.model}` : 'background brief'}
            </div>
            <h2 className="mt-2 text-xl font-semibold leading-tight tracking-[-0.025em] text-mist sm:text-2xl">
              {state.briefing?.headline ?? (state.agent.status === 'running' ? 'Reading the current workspace…' : 'Park a context without losing the thread.')}
            </h2>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex items-center gap-2 font-mono text-[11px] text-mist-faint">
              <span className="text-2xl tabular-nums text-mist">{active.length}</span>
              <span>open thread{active.length === 1 ? '' : 's'}</span>
            </div>
            {last && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void resume(last)}
                className="min-h-9 cursor-pointer rounded-md bg-amber px-3 py-1.5 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
              >
                {busy === `resume:${last.id}` ? 'Opening…' : 'Continue last Claude session'}
              </button>
            )}
          </div>
        </div>
        <p
          id="reentry-briefing-summary"
          className={`mt-3 max-w-2xl text-sm leading-relaxed text-mist-dim ${briefingOpen ? '' : 'line-clamp-3 sm:line-clamp-none'}`}
        >
          {state.briefing?.summary ?? 'Atrium captures the worktree and your note; the background agent turns only observed facts into a compact next-step capsule.'}
        </p>
        <button
          type="button"
          aria-expanded={briefingOpen}
          aria-controls="reentry-briefing-summary"
          onClick={() => setBriefingOpen((open) => !open)}
          className="mt-1 min-h-8 cursor-pointer font-mono text-[11px] text-mist-faint sm:hidden"
        >
          {briefingOpen ? 'Hide briefing' : 'Read briefing'}
        </button>
        {focusItems.length > 0 ? (
          <div className="mt-5 grid grid-flow-col auto-cols-[82%] gap-2 overflow-x-auto border-t border-white/[0.065] pt-4 pb-2 [scrollbar-width:none] md:grid-flow-row md:auto-cols-auto md:grid-cols-2 md:overflow-visible md:pb-0 xl:grid-cols-4">
            {focusItems.map((item, index) => (
              <button
                key={`${item.contextId ?? item.path ?? item.title}:${index}`}
                type="button"
                onClick={() => focusItem(item.contextId, item.path)}
                className="group min-w-0 snap-start cursor-pointer rounded-lg border border-white/[0.065] bg-white/[0.025] p-3 text-left transition-colors hover:border-white/[0.13] hover:bg-white/[0.045]"
              >
                <div className="truncate text-sm font-semibold text-mist">{item.title}</div>
                <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-mist-faint">{item.whyNow}</div>
                <div className="mt-3 line-clamp-2 text-xs leading-relaxed text-amber">{item.nextAction}</div>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {(state.error || state.agent.lastError) && (
        <div className="rounded-lg border border-coral/25 bg-coral/5 px-3 py-2 font-mono text-xs text-coral">
          {state.error ?? state.agent.lastError}
        </div>
      )}

      <div className="grid grid-cols-12 gap-5">
        <div className="col-span-12 space-y-5 xl:col-span-8">
          {active.length ? (
            active.map((context) => (
              <ContextCard
                key={context.id}
                context={context}
                busy={busy}
                armed={armed === context.id}
                onResume={() => void resume(context)}
                onArchive={() => void archive(context)}
              />
            ))
          ) : (
            <Panel title="Parked contexts" riseIndex={1}>
              <EmptyState>No open contexts. Use the parking card to preserve the next thread before you switch away.</EmptyState>
            </Panel>
          )}

          {done.length > 0 && (
            <Panel title="Recently done" rise={false} right={<span className="font-mono text-[11px] tabular-nums">{done.length}</span>}>
              <div className="divide-y divide-white/[0.055]">
                {done.slice(0, 8).map((context) => (
                  <div key={context.id} className="flex min-w-0 items-center gap-3 px-2 py-2.5">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-jade" />
                    <span className="min-w-0 flex-1 truncate text-sm text-mist-dim">{context.title}</span>
                    <span className="hidden truncate font-mono text-[11px] text-mist-faint sm:block">{context.path}</span>
                    <RelTime iso={context.updatedAt} />
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>

        <aside className="col-span-12 space-y-5 xl:col-span-4">
          <Panel title="Park this thread" riseIndex={2}>
            <form id="reentry-park" onSubmit={submitPark} className="space-y-4">
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Project path</span>
                <input
                  list="reentry-project-paths"
                  required
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="/home/…/projects/project"
                  className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 font-mono text-xs text-mist outline-none transition-colors placeholder:text-mist-faint focus:border-amber/35"
                />
                <datalist id="reentry-project-paths">
                  {repoOptions.map((repo) => <option key={repo.path} value={repo.path}>{repo.name}</option>)}
                </datalist>
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Title <span className="normal-case tracking-normal">optional</span></span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What is this thread?"
                  className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-sm text-mist outline-none transition-colors placeholder:text-mist-faint focus:border-amber/35"
                />
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Parking note</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={5}
                  placeholder="Goal, what is true, what failed, blocker, next move…"
                  className="mt-1.5 w-full resize-y rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-sm leading-relaxed text-mist outline-none transition-colors placeholder:text-mist-faint focus:border-amber/35"
                />
              </label>
              <fieldset>
                <legend className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Re-entry energy</legend>
                <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-white/[0.025] p-1">
                  {ENERGY.map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={energy === level}
                      onClick={() => setEnergy(level)}
                      className={`cursor-pointer rounded-md px-2 py-1.5 font-mono text-[11px] transition-colors ${energy === level ? 'bg-white/[0.09] text-mist' : 'text-mist-faint hover:text-mist-dim'}`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </fieldset>
              <button
                type="submit"
                disabled={!path.trim() || busy !== null}
                className="min-h-10 w-full cursor-pointer rounded-md bg-amber px-4 py-2 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
              >
                {busy === 'park' ? 'Capturing…' : 'Park + prepare'}
              </button>
            </form>
          </Panel>

          <Panel
            title="Background agent"
            riseIndex={3}
            right={
              <span className="inline-flex items-center gap-2 font-mono text-[10px]">
                <Dot status={state.agent.status === 'error' ? 'error' : state.agent.status === 'running' ? 'active' : 'running'} />
                <span>{state.agent.status}</span>
              </span>
            }
          >
            <div className="space-y-3 text-sm">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Grok model</div>
                <div className="mt-1 break-all font-mono text-xs text-mist">{state.agent.model || 'grok-4.6'}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 border-y border-white/[0.055] py-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-mist-faint">Prepared</div>
                  <div className="mt-1 text-xs text-mist-dim"><RelTime iso={state.agent.lastPreparedAt} /></div>
                </div>
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-mist-faint">Next scan</div>
                  <div className="mt-1 font-mono text-xs text-mist-dim">
                    {state.agent.nextRunAt
                      ? new Date(state.agent.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                      : '—'}
                  </div>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-mist-faint">
                Read-only evidence, no tools. Runs every 15 minutes and skips unchanged workspaces.
              </p>
              <button
                type="button"
                disabled={busy !== null || state.agent.status === 'running'}
                onClick={() => void scan()}
                className="command-trigger min-h-9 w-full cursor-pointer px-3 py-1.5 font-mono text-[11px] text-mist-dim transition-colors hover:text-mist disabled:cursor-default disabled:opacity-40"
              >
                {busy === 'scan' || state.agent.status === 'running' ? 'Scanning…' : 'Scan now'}
              </button>
            </div>
          </Panel>

          {state.briefing?.looseEnds.length ? (
            <Panel title="Observed loose ends" rise={false}>
              <div className="space-y-3">
                {state.briefing.looseEnds.map((item, index) => (
                  <button
                    key={`${item.label}:${index}`}
                    type="button"
                    disabled={!item.path}
                    onClick={() => item.path && focusItem(null, item.path)}
                    className="block w-full text-left disabled:cursor-default"
                  >
                    <span className="block text-sm text-mist-dim">{item.label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-mist-faint">{item.detail}</span>
                  </button>
                ))}
              </div>
            </Panel>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
