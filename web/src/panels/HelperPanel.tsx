import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import {
  dismissHelperOffer,
  launchHelperOffer,
  removeHelperMemory,
  scanHelper,
  snoozeHelperOffer,
  updateHelperSettings,
} from '../api';
import { Dot, RelTime } from '../components/ui';
import { useNow } from '../hooks';
import type {
  HelperExecutor,
  HelperOffer,
  HelperSourceStatus,
  HelperState,
  Snapshot,
} from '../../../shared/types';

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
      model: 'claude:opus',
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
    <aside className="helper-memory min-w-0 space-y-7 xl:sticky xl:top-6 xl:self-start">
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
    </aside>
  );
}

export default function HelperPanel({ snapshot }: { snapshot: Snapshot }) {
  const state = snapshot.helper ?? emptyHelper();
  const active = state.offers.filter((offer) => offer.status === 'offered');
  const history = state.offers.filter((offer) => offer.status !== 'offered');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const showNotice = (text: string, error = false) => {
    setNotice({ text, error });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 6_000);
  };

  const scan = async () => {
    if (busy) return;
    setBusy('scan');
    try {
      await scanHelper();
      showNotice('Opus 5 scout started.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(null);
    }
  };

  const changeCadence = async (intervalMs: number) => {
    if (busy || intervalMs === state.settings.intervalMs) return;
    setBusy('settings');
    try {
      await updateHelperSettings({ ...state.settings, intervalMs });
      showNotice(`Scout cadence changed to ${CADENCES.find((entry) => entry.value === intervalMs)?.label.toLowerCase() ?? 'the selected interval'}.`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {notice && (
        <div role="status" className={`rounded-md border px-3 py-2 text-sm ${notice.error ? 'border-coral/30 bg-coral/5 text-coral' : 'border-jade/25 bg-jade/5 text-jade'}`}>
          {notice.text}
        </div>
      )}

      <section className={`helper-command stat-band rise px-4 py-4 sm:px-5 ${state.agent.status === 'running' ? 'is-scanning' : ''}`} style={{ '--rise-i': 0 } as CSSProperties}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-mist-faint">
              <Dot status={state.agent.status === 'running' ? 'active' : state.agent.status === 'error' ? 'error' : 'running'} />
              <span>Claude Code</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-glow">Opus 5</span>
              {state.agent.lastCheckedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>checked <RelTime iso={state.agent.lastCheckedAt} /></span>
                </>
              )}
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mist-dim">
              {state.agent.status === 'running'
                ? 'Reading the current evidence and deciding whether anything deserves your attention.'
                : state.scanSummary ?? 'No scan has completed yet.'}
            </p>
            {state.agent.lastError && <p className="mt-2 text-xs leading-relaxed text-coral">{state.agent.lastError}</p>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="helper-cadence">Scout cadence</label>
            <select
              id="helper-cadence"
              value={state.settings.intervalMs}
              disabled={busy !== null}
              onChange={(event) => void changeCadence(Number(event.target.value))}
              className="min-h-11 cursor-pointer rounded-md border border-white/10 bg-ink-2 px-3 font-mono text-[11px] text-mist outline-none focus:border-amber/40 disabled:opacity-50"
            >
              {CADENCES.map((cadence) => <option key={cadence.value} value={cadence.value}>{cadence.label}</option>)}
            </select>
            <button
              type="button"
              disabled={busy !== null || state.agent.status === 'running'}
              onClick={() => void scan()}
              className="min-h-11 cursor-pointer rounded-md border border-white/10 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-amber/35 hover:text-amber disabled:cursor-default disabled:opacity-50"
            >
              {state.agent.status === 'running' ? 'Scanning…' : 'Scan now'}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.055] pt-3 font-mono text-[10px] text-mist-faint">
          <span><strong className="font-medium text-mist">{active.length}</strong> open offer{active.length === 1 ? '' : 's'}</span>
          <span><strong className="font-medium text-mist">{history.length}</strong> in history</span>
          {state.agent.nextRunAt && <span>next <InTime iso={state.agent.nextRunAt} /></span>}
        </div>
      </section>

      <div className="grid min-w-0 gap-7 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0 space-y-4" aria-label="offers">
          {active.length ? active.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              defaultExecutor={state.settings.defaultExecutor}
              busy={busy}
              onBusy={setBusy}
              onNotice={showNotice}
            />
          )) : (
            <div className="helper-clear rise min-h-64 border-y border-white/[0.07] px-4 py-16 text-center" style={{ '--rise-i': 1 } as CSSProperties}>
              <div className="mx-auto h-px w-16 bg-jade/55" />
              <h2 className="mt-5 text-xl font-semibold text-mist">Nothing worth interrupting you for.</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-mist-dim">
                {state.agent.lastCheckedAt ? 'The scout checked the available evidence and kept the queue quiet.' : 'Run the first Opus 5 scan when you are ready.'}
              </p>
            </div>
          )}
        </section>

        <MemoryRail state={state} busy={busy} onBusy={setBusy} onNotice={showNotice} />
      </div>

      {history.length > 0 && (
        <details className="helper-history border-y border-white/[0.07] py-1">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-2 py-2">
            <span className="text-sm font-semibold text-mist">Previous offers</span>
            <span className="font-mono text-[10px] tabular-nums text-mist-faint">{history.length}</span>
          </summary>
          <div className="divide-y divide-white/[0.055] border-t border-white/[0.055]">
            {history.slice(0, 80).map((offer) => (
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
    </div>
  );
}
