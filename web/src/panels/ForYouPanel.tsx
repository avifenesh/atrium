import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  archiveReentry,
  dismissHelperOffer,
  launchHelperOffer,
  parkReentry,
  removeHelperMemory,
  resumeReentry,
  scanHelper,
  scanReentry,
  snoozeHelperOffer,
  updateHelperSettings,
} from '../api';
import { Dot, Panel, RelTime } from '../components/ui';
import { useNow } from '../hooks';
import type {
  HelperExecutor,
  HelperOffer,
  HelperSourceStatus,
  HelperState,
  ReentryContext,
  ReentryEnergy,
  ReentryState,
  Snapshot,
} from '../../../shared/types';

const ENERGY: ReentryEnergy[] = ['light', 'medium', 'deep'];

const CADENCES = [
  { value: 10 * 60_000, label: 'Every 10 minutes' },
  { value: 30 * 60_000, label: 'Every 30 minutes' },
  { value: 60 * 60_000, label: 'Hourly' },
  { value: 3 * 60 * 60_000, label: 'Every 3 hours' },
  { value: 6 * 60 * 60_000, label: 'Every 6 hours' },
  { value: 12 * 60 * 60_000, label: 'Every 12 hours' },
  { value: 24 * 60 * 60_000, label: 'Daily' },
  { value: 3 * 24 * 60 * 60_000, label: 'Every 3 days' },
  { value: 7 * 24 * 60 * 60_000, label: 'Weekly' },
];

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

function emptyHelper(): HelperState {
  return {
    updatedAt: null,
    offers: [],
    preferences: [],
    skills: [],
    feedback: [],
    sources: [],
    settings: { intervalMs: 3 * 60 * 60_000, defaultExecutor: 'claude' },
    agent: {
      status: 'idle',
      model: 'glm:glm-5.3',
      lastCheckedAt: null,
      lastOfferedAt: null,
      lastError: null,
      nextRunAt: null,
    },
    scanSummary: null,
    error: null,
  };
}

function sourceTone(status: HelperSourceStatus['status']): string {
  if (status === 'ready') return 'bg-jade';
  if (status === 'limited') return 'bg-amber';
  if (status === 'error') return 'bg-coral';
  if (status === 'pending') return 'bg-slate-glow signal-pulse';
  return 'bg-mist-faint';
}

function InTime({ iso }: { iso: string }) {
  const now = useNow(30_000);
  const seconds = Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1_000));
  const value = seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.ceil(seconds / 60)}m`
      : seconds < 86_400
        ? `${Math.ceil(seconds / 3_600)}h`
        : `${Math.ceil(seconds / 86_400)}d`;
  return <span className="font-mono text-[10px] tabular-nums text-mist-faint">in {value}</span>;
}

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

function OfferEvidence({ offer }: { offer: HelperOffer }) {
  return (
    <div className="helper-evidence mt-5">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Observed</div>
      <div className="space-y-2">
        {offer.evidence.map((evidence, index) => {
          const content = (
            <>
              <span className="font-mono text-[10px] uppercase text-slate-glow">{evidence.source}</span>
              <span className="min-w-0 text-xs leading-relaxed text-mist-dim">
                <span className="font-medium text-mist">{evidence.label}</span>
                {' · '}
                {evidence.detail}
              </span>
            </>
          );
          return evidence.href ? (
            <a
              key={`${evidence.source}:${evidence.id}:${index}`}
              href={evidence.href}
              target="_blank"
              rel="noreferrer"
              className="helper-evidence-row grid min-h-9 grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/[0.035]"
            >
              {content}
            </a>
          ) : (
            <div
              key={`${evidence.source}:${evidence.id}:${index}`}
              className="helper-evidence-row grid min-h-9 grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2 px-2 py-1.5"
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OfferCard({
  offer,
  defaultExecutor,
  busy,
  onBusy,
  onNotice,
}: {
  offer: HelperOffer;
  defaultExecutor: HelperExecutor;
  busy: string | null;
  onBusy: (value: string | null) => void;
  onNotice: (text: string, error?: boolean) => void;
}) {
  const [mode, setMode] = useState<'launch' | 'dismiss' | null>(null);
  const [prompt, setPrompt] = useState(offer.prompt);
  const [reason, setReason] = useState('');
  const [remember, setRemember] = useState(true);

  useEffect(() => setPrompt(offer.prompt), [offer.prompt]);

  const launch = async (executor: HelperExecutor) => {
    if (busy) return;
    onBusy(`launch:${offer.id}`);
    try {
      await launchHelperOffer(offer.id, executor, prompt);
      onNotice(`Opened ${offer.title} in Kitty with ${executor === 'claude' ? 'Claude Code Opus 5' : 'Codex'}.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      onBusy(null);
    }
  };

  const dismiss = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim() || busy) return;
    onBusy(`dismiss:${offer.id}`);
    try {
      await dismissHelperOffer(offer.id, reason.trim(), remember);
      onNotice(remember ? 'Offer dismissed and the working agreement was updated.' : 'Offer dismissed.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      onBusy(null);
    }
  };

  const snooze = async () => {
    if (busy) return;
    onBusy(`snooze:${offer.id}`);
    try {
      await snoozeHelperOffer(offer.id);
      onNotice('Offer will return tomorrow.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      onBusy(null);
    }
  };

  return (
    <article className="helper-offer panel-surface rise min-w-0 overflow-hidden" style={{ '--rise-i': 1 } as CSSProperties}>
      <div className="helper-offer-body p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase text-mist-faint">
              <span>{offer.size}</span>
              <span aria-hidden="true">·</span>
              <span>{Math.round(offer.confidence * 100)}% confidence</span>
              {offer.path && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="max-w-64 truncate text-slate-glow" title={offer.path}>{offer.path}</span>
                </>
              )}
            </div>
            <h2 className="mt-2 text-lg font-semibold leading-snug text-mist sm:text-xl">{offer.title}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mist-dim">{offer.summary}</p>
          </div>
          <span className="helper-new shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-amber">offer</span>
        </div>

        <div className="mt-5 grid gap-4 border-y border-white/[0.055] py-4 sm:grid-cols-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Why now</div>
            <p className="mt-1 text-sm leading-relaxed text-mist">{offer.whyNow}</p>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">Done looks like</div>
            <p className="mt-1 text-sm leading-relaxed text-mist">{offer.outcome}</p>
          </div>
        </div>

        <OfferEvidence offer={offer} />

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.055] pt-4">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setMode(mode === 'dismiss' ? null : 'dismiss')}
            className="min-h-11 cursor-pointer rounded-md px-3 py-2 font-mono text-[11px] text-mist-faint transition-colors hover:bg-white/5 hover:text-mist disabled:cursor-default disabled:opacity-50"
          >
            Not for me
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void snooze()}
            className="min-h-11 cursor-pointer rounded-md px-3 py-2 font-mono text-[11px] text-mist-faint transition-colors hover:bg-white/5 hover:text-mist disabled:cursor-default disabled:opacity-50"
          >
            Tomorrow
          </button>
          <button
            type="button"
            disabled={busy !== null}
            aria-expanded={mode === 'launch'}
            onClick={() => setMode(mode === 'launch' ? null : 'launch')}
            className="min-h-11 cursor-pointer rounded-md bg-amber px-4 py-2 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            Review handoff
          </button>
        </div>
      </div>

      {mode === 'launch' && (
        <div className="helper-composer border-t border-white/[0.08] bg-white/[0.018] p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label htmlFor={`helper-prompt-${offer.id}`} className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber">
              Exact agent prompt
            </label>
            <span className="font-mono text-[10px] text-mist-faint">{prompt.length.toLocaleString()} characters</span>
          </div>
          <textarea
            id={`helper-prompt-${offer.id}`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={13}
            spellCheck={false}
            className="mt-2 w-full resize-y rounded-md border border-white/10 bg-ink/55 px-3 py-3 font-mono text-xs leading-relaxed text-mist outline-none transition-colors focus:border-amber/45"
          />
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPrompt(offer.prompt)}
              disabled={prompt === offer.prompt || busy !== null}
              className="min-h-11 cursor-pointer rounded-md px-3 py-2 font-mono text-[11px] text-mist-faint hover:bg-white/5 hover:text-mist disabled:cursor-default disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => void launch('codex')}
              disabled={busy !== null || prompt.trim().length < 80}
              className={`min-h-11 cursor-pointer rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50 ${
                defaultExecutor === 'codex' ? 'border-slate-glow/40 bg-slate-glow/10 text-mist' : 'border-white/10 text-mist-dim hover:border-white/20 hover:text-mist'
              }`}
            >
              {busy === `launch:${offer.id}` ? 'Opening…' : 'Open in Codex'}
            </button>
            <button
              type="button"
              onClick={() => void launch('claude')}
              disabled={busy !== null || prompt.trim().length < 80}
              className={`min-h-11 cursor-pointer rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50 ${
                defaultExecutor === 'claude' ? 'border-amber/45 bg-amber/10 text-amber' : 'border-white/10 text-mist-dim hover:border-white/20 hover:text-mist'
              }`}
            >
              {busy === `launch:${offer.id}` ? 'Opening…' : 'Open in Claude Opus 5'}
            </button>
          </div>
        </div>
      )}

      {mode === 'dismiss' && (
        <form onSubmit={dismiss} className="border-t border-white/[0.08] bg-white/[0.018] p-4 sm:p-5">
          <label htmlFor={`helper-reason-${offer.id}`} className="text-sm font-medium text-mist">
            Why is this not useful?
          </label>
          <textarea
            id={`helper-reason-${offer.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            autoFocus
            placeholder="For example: I am not interested in Valkey Glide work."
            className="mt-2 w-full resize-y rounded-md border border-white/10 bg-ink/55 px-3 py-3 text-sm leading-relaxed text-mist outline-none transition-colors placeholder:text-mist-faint focus:border-amber/45"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-mist-dim">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-4 w-4 accent-amber"
              />
              Add this to my working agreement
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMode(null)}
                className="min-h-11 cursor-pointer rounded-md px-3 py-2 font-mono text-[11px] text-mist-faint hover:bg-white/5 hover:text-mist"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!reason.trim() || busy !== null}
                className="min-h-11 cursor-pointer rounded-md bg-coral/12 px-4 py-2 text-sm font-medium text-coral hover:bg-coral/18 disabled:cursor-default disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        </form>
      )}
    </article>
  );
}

function MemoryRail({
  state,
  busy,
  onBusy,
  onNotice,
}: {
  state: HelperState;
  busy: string | null;
  onBusy: (value: string | null) => void;
  onNotice: (text: string, error?: boolean) => void;
}) {
  const remove = async (kind: 'preferences' | 'skills', id: string) => {
    if (busy) return;
    onBusy(`${kind}:${id}`);
    try {
      await removeHelperMemory(kind, id);
      onNotice(kind === 'preferences' ? 'Working agreement updated.' : 'Skill removed.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      onBusy(null);
    }
  };

  return (
    <div className="helper-memory min-w-0 space-y-7">
      <section>
        <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.07] pb-2">
          <h2 className="text-sm font-semibold text-mist">Working agreement</h2>
          <span className="font-mono text-[10px] tabular-nums text-mist-faint">{state.preferences.length}</span>
        </div>
        {state.preferences.length ? (
          <div className="divide-y divide-white/[0.055]">
            {state.preferences.map((preference) => (
              <div key={preference.id} className="flex min-w-0 items-start gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <div className={`font-mono text-[9px] uppercase tracking-[0.13em] ${preference.kind === 'avoid' ? 'text-coral' : preference.kind === 'prefer' ? 'text-jade' : 'text-slate-glow'}`}>
                    {preference.kind}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-mist-dim">{preference.statement}</p>
                </div>
                <button
                  type="button"
                  title="Remove rule"
                  aria-label={`Remove rule: ${preference.statement}`}
                  disabled={busy !== null}
                  onClick={() => void remove('preferences', preference.id)}
                  className="min-h-11 min-w-11 shrink-0 cursor-pointer rounded text-mist-faint transition-colors hover:bg-white/5 hover:text-coral disabled:cursor-default disabled:opacity-40"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-3 text-sm leading-relaxed text-mist-faint">No learned boundaries yet.</p>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.07] pb-2">
          <h2 className="text-sm font-semibold text-mist">Agent skills</h2>
          <span className="font-mono text-[10px] tabular-nums text-mist-faint">{state.skills.length}</span>
        </div>
        {state.skills.length ? (
          <div className="divide-y divide-white/[0.055]">
            {state.skills.map((skill) => (
              <details key={skill.id} className="group py-3">
                <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-mist">{skill.name}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-mist-faint">{skill.description}</span>
                  </span>
                  <span className="font-mono text-xs text-mist-faint transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-mist-dim">{skill.instructions}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[9px] text-mist-faint" title={skill.path}>{skill.path}</span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove('skills', skill.id)}
                    className="min-h-9 shrink-0 cursor-pointer rounded px-2 font-mono text-[10px] text-mist-faint hover:bg-white/5 hover:text-coral disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p className="py-3 text-sm leading-relaxed text-mist-faint">No reusable procedures learned yet.</p>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.07] pb-2">
          <h2 className="text-sm font-semibold text-mist">Evidence sources</h2>
          <span className="font-mono text-[10px] tabular-nums text-mist-faint">{state.sources.filter((source) => source.status === 'ready').length}/{state.sources.length}</span>
        </div>
        <div className="divide-y divide-white/[0.055]">
          {state.sources.map((source) => (
            <div key={source.id} className="flex min-w-0 items-start gap-2 py-3">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${sourceTone(source.status)}`} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-mist">{source.label}</span>
                  <span className="font-mono text-[9px] uppercase text-mist-faint">{source.status}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-mist-faint">{source.detail}</p>
              </div>
            </div>
          ))}
          {!state.sources.length && <p className="py-3 text-sm text-mist-faint">Sources appear after the first scan.</p>}
        </div>
      </section>
    </div>
  );
}

type ForYouItem = { kind: 'thread'; context: ReentryContext } | { kind: 'offer'; offer: HelperOffer };

export default function ForYouPanel({ snapshot }: { snapshot: Snapshot }) {
  const reentry = snapshot.reentry ?? emptyReentry();
  const helper = snapshot.helper ?? emptyHelper();
  const doneThreads = reentry.contexts.filter((context) => context.state === 'done');
  const historyOffers = helper.offers.filter((offer) => offer.status !== 'offered');
  const last = reentry.lastLaunch
    ? reentry.contexts.find((context) => context.id === reentry.lastLaunch?.contextId && context.state !== 'done') ?? null
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
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const threads = useMemo(() => {
    const active = reentry.contexts.filter((context) => context.state !== 'done');
    const focusIds = (reentry.briefing?.focus ?? [])
      .map((item) => item.contextId)
      .filter((value): value is string => Boolean(value));
    const rank = (id: string) => {
      const index = focusIds.indexOf(id);
      return index < 0 ? focusIds.length : index;
    };
    return active.map((context, index) => ({ context, index })).sort((a, b) => rank(a.context.id) - rank(b.context.id) || a.index - b.index).map((entry) => entry.context);
  }, [reentry.contexts, reentry.briefing?.focus]);
  const offers = helper.offers.filter((offer) => offer.status === 'offered');
  const items: ForYouItem[] = [];
  for (let index = 0; index < Math.max(threads.length, offers.length); index++) {
    if (threads[index]) items.push({ kind: 'thread', context: threads[index] });
    if (offers[index]) items.push({ kind: 'offer', offer: offers[index] });
  }
  const focusItems = (reentry.briefing?.focus ?? []).filter(
    (item) => threads.length !== 1 || item.contextId !== threads[0]?.id,
  );

  const showNotice = (text: string, error = false) => {
    setNotice({ text, error });
    window.setTimeout(() => setNotice((current) => (current?.text === text ? null : current)), 6_000);
  };

  const submitPark = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim() || busy) return;
    setBusy('park');
    try {
      const context = await parkReentry({ path: path.trim(), title, note, energy });
      setTitle('');
      setNote('');
      showNotice(`${context.title} parked. Preparing its status now.`);
      await scanReentry().catch((err) => showNotice(`Parked, but scan could not start: ${err instanceof Error ? err.message : String(err)}`, true));
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const resume = async (context: ReentryContext) => {
    setBusy(`resume:${context.id}`);
    try {
      const result = await resumeReentry(context.id);
      showNotice(result.launched ? `Opened ${context.title} in ${result.via}.` : `Could not open a terminal: ${result.via}`, !result.launched);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err), true);
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
      showNotice(`${context.title} moved to done.`);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const scanReentryNow = async () => {
    setBusy('reentry-scan');
    try {
      await scanReentry();
      showNotice('Re-entry scan queued.');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const scanHelperNow = async () => {
    if (busy) return;
    setBusy('helper-scan');
    try {
      await scanHelper();
      showNotice('Scout scan started.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(null);
    }
  };

  const changeCadence = async (intervalMs: number) => {
    if (busy || intervalMs === helper.settings.intervalMs) return;
    setBusy('settings');
    try {
      await updateHelperSettings({ ...helper.settings, intervalMs });
      showNotice(`Scout cadence changed to ${CADENCES.find((entry) => entry.value === intervalMs)?.label.toLowerCase() ?? 'the selected interval'}.`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
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

  const preparing = reentry.agent.status === 'running' || helper.agent.status === 'running';
  const errors = [reentry.error ?? reentry.agent.lastError, helper.error ?? helper.agent.lastError].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      {notice && (
        <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${notice.error ? 'border-coral/30 bg-coral/5 text-coral' : 'border-jade/25 bg-jade/5 text-jade'}`}>
          {notice.text}
        </div>
      )}

      <section className={`stat-band rise px-5 py-5 sm:px-6 ${preparing ? 'is-scanning' : ''}`} style={{ '--rise-i': 0 } as CSSProperties}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mist-faint">
              {reentry.briefing ? `prepared by ${reentry.briefing.model}` : 'background brief'}
            </div>
            <h2 className="mt-2 text-xl font-semibold leading-tight tracking-[-0.025em] text-mist sm:text-2xl">
              {reentry.briefing?.headline ?? (preparing ? 'Reading the current workspace…' : 'Pick a thread back up, or take an offer off the scout.')}
            </h2>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex items-center gap-2 font-mono text-[11px] text-mist-faint">
              <span className="text-2xl tabular-nums text-mist">{threads.length}</span>
              <span>thread{threads.length === 1 ? '' : 's'}</span>
              <span aria-hidden="true">·</span>
              <span className="text-2xl tabular-nums text-mist">{offers.length}</span>
              <span>offer{offers.length === 1 ? '' : 's'}</span>
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
          id="foryou-briefing-summary"
          className={`mt-3 max-w-2xl text-sm leading-relaxed text-mist-dim ${briefingOpen ? '' : 'line-clamp-3 sm:line-clamp-none'}`}
        >
          {reentry.briefing?.summary ?? 'Atrium keeps parked threads and evidence-backed offers in one queue; the background agents turn only observed facts into next steps.'}
        </p>
        <button
          type="button"
          aria-expanded={briefingOpen}
          aria-controls="foryou-briefing-summary"
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
        <div className="mt-5 grid gap-4 border-t border-white/[0.065] pt-4 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-mist-faint">
              <Dot status={reentry.agent.status === 'error' ? 'error' : reentry.agent.status === 'running' ? 'active' : 'running'} />
              <span>Re-entry brief</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-glow">{reentry.agent.model || 'glm:glm-5.3'}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-mist-faint">
              <span>prepared <RelTime iso={reentry.agent.lastPreparedAt} /></span>
              {reentry.agent.nextRunAt && (
                <span>next {new Date(reentry.agent.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              )}
              <button
                type="button"
                disabled={busy !== null || reentry.agent.status === 'running'}
                onClick={() => void scanReentryNow()}
                className="command-trigger min-h-8 cursor-pointer font-mono text-[10px] text-mist-dim transition-colors hover:text-mist disabled:cursor-default disabled:opacity-40"
              >
                {busy === 'reentry-scan' || reentry.agent.status === 'running' ? 'Scanning…' : 'Scan now'}
              </button>
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-mist-faint">
              <Dot status={helper.agent.status === 'running' ? 'active' : helper.agent.status === 'error' ? 'error' : 'running'} />
              <span>Scout</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-glow">{helper.agent.model || 'glm:glm-5.3'}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-mist-faint">
              {helper.agent.lastCheckedAt && <span>checked <RelTime iso={helper.agent.lastCheckedAt} /></span>}
              {helper.agent.nextRunAt && <InTime iso={helper.agent.nextRunAt} />}
              <label className="sr-only" htmlFor="helper-cadence">Scout cadence</label>
              <select
                id="helper-cadence"
                value={helper.settings.intervalMs}
                disabled={busy !== null}
                onChange={(event) => void changeCadence(Number(event.target.value))}
                className="min-h-8 cursor-pointer rounded-md border border-white/10 bg-ink-2 px-2 font-mono text-[10px] text-mist outline-none focus:border-amber/40 disabled:opacity-50"
              >
                {CADENCES.map((cadence) => <option key={cadence.value} value={cadence.value}>{cadence.label}</option>)}
              </select>
              <button
                type="button"
                disabled={busy !== null || helper.agent.status === 'running'}
                onClick={() => void scanHelperNow()}
                className="command-trigger min-h-8 cursor-pointer font-mono text-[10px] text-mist-dim transition-colors hover:text-mist disabled:cursor-default disabled:opacity-40"
              >
                {busy === 'helper-scan' || helper.agent.status === 'running' ? 'Scanning…' : 'Scan now'}
              </button>
            </div>
            {helper.scanSummary && <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-mist-dim">{helper.scanSummary}</p>}
          </div>
        </div>
      </section>

      {errors.length > 0 && (
        <div role="alert" className="space-y-1 rounded-lg border border-coral/25 bg-coral/5 px-3 py-2 font-mono text-xs text-coral">
          {errors.map((error) => <div key={error}>{error}</div>)}
        </div>
      )}

      <div className="grid min-w-0 gap-7 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0 space-y-4" aria-label="For you">
          {items.length ? items.map((item) => item.kind === 'thread' ? (
            <ContextCard
              key={`thread:${item.context.id}`}
              context={item.context}
              busy={busy}
              armed={armed === item.context.id}
              onResume={() => void resume(item.context)}
              onArchive={() => void archive(item.context)}
            />
          ) : (
            <OfferCard
              key={`offer:${item.offer.id}`}
              offer={item.offer}
              defaultExecutor={helper.settings.defaultExecutor}
              busy={busy}
              onBusy={setBusy}
              onNotice={showNotice}
            />
          )) : (
            <div className="helper-clear rise min-h-64 border-y border-white/[0.07] px-4 py-16 text-center" style={{ '--rise-i': 1 } as CSSProperties}>
              <div className="mx-auto h-px w-16 bg-jade/55" />
              <h2 className="mt-5 text-xl font-semibold text-mist">Nothing waiting.</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-mist-dim">
                No open threads and no open offers. Park a thread before you switch away, or run a scan when you want fresh suggestions.
              </p>
            </div>
          )}

          {doneThreads.length > 0 && (
            <Panel title="Recently done" rise={false} right={<span className="font-mono text-[11px] tabular-nums">{doneThreads.length}</span>}>
              <div className="divide-y divide-white/[0.055]">
                {doneThreads.slice(0, 8).map((context) => (
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

          {historyOffers.length > 0 && (
            <details className="helper-history border-y border-white/[0.07] py-1">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-2 py-2">
                <span className="text-sm font-semibold text-mist">Previous offers</span>
                <span className="font-mono text-[10px] tabular-nums text-mist-faint">{historyOffers.length}</span>
              </summary>
              <div className="divide-y divide-white/[0.055] border-t border-white/[0.055]">
                {historyOffers.slice(0, 80).map((offer) => (
                  <div key={offer.id} className="grid min-w-0 gap-2 px-2 py-4 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-start">
                    <div className={`font-mono text-[10px] uppercase tracking-[0.12em] ${offer.status === 'accepted' ? 'text-jade' : offer.status === 'declined' ? 'text-coral' : 'text-mist-faint'}`}>
                      {offer.status}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-mist">{offer.title}</div>
                      <p className="mt-1 text-xs leading-relaxed text-mist-faint">
                        {offer.feedback ?? (offer.launchedWith ? `Opened in ${offer.launchedWith}.` : offer.summary)}
                      </p>
                      {offer.launchedPrompt && (
                        <details className="mt-2">
                          <summary className="min-h-9 cursor-pointer py-2 font-mono text-[10px] text-slate-glow">Exact launched prompt</summary>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-white/[0.07] bg-white/[0.018] p-3 font-mono text-[11px] leading-relaxed text-mist-dim">{offer.launchedPrompt}</pre>
                        </details>
                      )}
                    </div>
                    <RelTime iso={offer.updatedAt} />
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        <aside className="min-w-0 space-y-5">
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

          {reentry.briefing?.looseEnds.length ? (
            <Panel title="Observed loose ends" rise={false}>
              <div className="space-y-3">
                {reentry.briefing.looseEnds.map((item, index) => (
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

          <MemoryRail state={helper} busy={busy} onBusy={setBusy} onNotice={showNotice} />
        </aside>
      </div>
    </div>
  );
}
