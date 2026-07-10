import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Dot, RelTime } from '../../components/ui';
import { useTweenNumber } from '../../hooks';
import {
  getGrounding,
  getModels,
  getResearchStatus,
  getRetriever,
  resumeResearch,
  sendGroundingFeedback,
  setFallbackBm25,
  setModel as persistModel,
  startResearch,
  stopResearch,
} from './api';
import type { ItchResearch, SxcGroundingReviewItem, SxcGroundingState } from '../../../../shared/types';

// ---------- research strip (rise 0) ----------

const FLAG_DEFS = [
  ['no_gh', 'Skip GitHub'],
  ['no_local', 'Skip local scan'],
  ['fresh', 'Ignore prior runs'],
  ['no_history', 'Ignore history'],
  ['market', 'Use market lens'],
] as const;

type FlagKey = (typeof FLAG_DEFS)[number][0];

const EMPTY_GROUNDING: SxcGroundingState = {
  updatedAt: null,
  retriever: null,
  threshold: 0,
  pending: [],
  reviewedTotal: 0,
  error: null,
};

interface ExitInfo {
  code: number | null;
  savedStem: string | null;
  killedReason: string | null;
  resumable: boolean;
}

export function ResearchStrip({
  research,
  grounding,
  onSaved,
}: {
  research: ItchResearch;
  grounding?: SxcGroundingState;
  onSaved: (stem: string) => void;
}) {
  // local truth once a start/stop/poll has spoken; null = follow the snapshot
  const [override, setOverride] = useState<boolean | null>(null);
  const running = override ?? research.running;

  const [flags, setFlags] = useState<Record<FlagKey, boolean>>({
    no_gh: false,
    no_local: false,
    fresh: false,
    no_history: false,
    market: false,
  });
  const [temp, setTemp] = useState(0); // 0 = baseline (collision_temp omitted); >0 = chaos dial
  // drags move by 1 (tween is a no-op); track clicks and pgup/pgdn jump — those glide
  const shownTemp = useTweenNumber(temp, 200);
  const [orbit, setOrbit] = useState(''); // free-text center to focus the run; '' = off
  // collide (scatter) and orbit (focus) are opposites — the engine refuses both,
  // so the UI makes them mutually exclusive: a non-empty value disables the other.
  const orbitOn = orbit.trim().length > 0;
  const collideOn = temp > 0;
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [exit, setExit] = useState<ExitInfo | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(research.started);
  const [log, setLog] = useState<string[]>([]);
  const [partial, setPartial] = useState('');
  const [pollDown, setPollDown] = useState(false); // 3+ consecutive status-poll failures

  // low-confidence sxc grounding hits are tagged for explicit review; thumbs feed
  // the next mining pass by boosting/down-weighting similar seed+chunk pairs.
  const [groundingState, setGroundingState] = useState<SxcGroundingState>(grounding ?? EMPTY_GROUNDING);
  const [feedbackBusy, setFeedbackBusy] = useState<Record<string, boolean>>({});
  const [feedbackErr, setFeedbackErr] = useState<string | null>(null);

  // model picker — null until /models answers; load failure keeps it hidden (upstream default applies)
  const [models, setModels] = useState<{ id: string; label?: string }[] | null>(null);
  const [model, setModelId] = useState<string | null>(null);

  // sxc retriever fallback — persistent toggle. true = itch-intent mining is
  // forced onto bm25 (use while the ColBERT index is stale/rebuilding); false =
  // the skill's own ColBERT choice applies. Loaded once; flips persist server-side.
  const [fallbackBm25, setFallbackBm25State] = useState(false);

  const linesRef = useRef(0); // absolute log lines we hold (the delta protocol's `since`)
  const pollFailsRef = useRef(0);
  const startedRef = useRef<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true); // auto-scroll only while the user is at the bottom
  // our own smooth scrollTo emits intermediate scroll events that read as "not at
  // bottom" — they must not unstick the follow; wheel/touch hand control back
  const glidingRef = useRef(false);

  useEffect(() => {
    setGroundingState(grounding ?? EMPTY_GROUNDING);
  }, [grounding]);

  // a run started elsewhere (cli, another tab): snapshot's started changes → follow it again
  const prevStartedProp = useRef(research.started);
  useEffect(() => {
    if (research.started !== prevStartedProp.current) {
      prevStartedProp.current = research.started;
      if (research.started !== null) setOverride(null);
    }
  }, [research.started]);

  // model list — once on mount; silent failure hides the select entirely
  useEffect(() => {
    const ac = new AbortController();
    getModels(ac.signal)
      .then((m) => {
        if (m.models.length === 0) return;
        setModels(m.models);
        setModelId(m.selected || m.default || m.models[0].id);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // retriever fallback state — once on mount; silent failure leaves it off
  useEffect(() => {
    const ac = new AbortController();
    getRetriever(ac.signal)
      .then((r) => setFallbackBm25State(r.fallback_bm25))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // status poll — 2s setTimeout chain while mounted and running; aborts on unmount
  useEffect(() => {
    if (!running) return;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let gone = false;
    const tick = async () => {
      try {
        const st = await getResearchStatus(linesRef.current, ac.signal);
        if (gone) return;
        pollFailsRef.current = 0;
        setPollDown(false);
        if (st.started !== null && startedRef.current !== null && st.started !== startedRef.current) {
          // a new run replaced the one we were tailing — reset the buffer, refetch from 0
          startedRef.current = st.started;
          setStartedAt(st.started);
          linesRef.current = 0;
          setLog([]);
          setPartial('');
          setExit(null);
          timer = setTimeout(tick, 0);
          return;
        }
        if (st.started !== null) {
          startedRef.current = st.started;
          setStartedAt(st.started);
        }
        if (st.log_truncated) {
          linesRef.current = st.log_offset + st.log.length;
          setLog(st.log);
        } else if (st.log.length > 0) {
          linesRef.current += st.log.length;
          setLog((l) => [...l, ...st.log]);
        }
        setPartial(st.partial);
        if (!st.running) {
          setOverride(false);
          setExit({ code: st.exit_code, savedStem: st.saved_stem, killedReason: st.killed_reason, resumable: !!st.resumable });
          if (st.saved_stem) onSaved(st.saved_stem);
          return;
        }
      } catch {
        if (gone) return; // unmount abort lands here; network blips just retry
        pollFailsRef.current += 1;
        if (pollFailsRef.current >= 3) setPollDown(true); // stop claiming "running" against a dead server
      }
      timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      gone = true;
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, [running, onSaved]);

  // follow the feed only when the user already sits at the bottom — never fight
  // scrollback. smooth glide, instant under prefers-reduced-motion.
  useEffect(() => {
    const el = logBoxRef.current;
    if (!el || !stickRef.current) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    glidingRef.current = !reduced;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [log, partial]);

  // optimistic flip; revert + surface on failure so the UI never lies about state
  const toggleFallback = async (on: boolean) => {
    setFallbackBm25State(on);
    try {
      const { status, body } = await setFallbackBm25(on);
      if (!body?.ok) {
        setFallbackBm25State(!on);
        setMsg({ text: body?.error ?? `retriever toggle failed (${status})`, isError: true });
      }
    } catch (e) {
      setFallbackBm25State(!on);
      setMsg({ text: e instanceof Error ? e.message : String(e), isError: true });
    }
  };

  const submitGroundingFeedback = async (item: SxcGroundingReviewItem, feedback: 'up' | 'down') => {
    setFeedbackBusy((b) => ({ ...b, [item.id]: true }));
    setFeedbackErr(null);
    try {
      const { status, body } = await sendGroundingFeedback(item.id, feedback);
      if (body?.ok && body.grounding) {
        setGroundingState(body.grounding);
      } else {
        setFeedbackErr(body?.error ?? `feedback failed (${status})`);
        setGroundingState(await getGrounding());
      }
    } catch (e) {
      setFeedbackErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFeedbackBusy((b) => {
        const next = { ...b };
        delete next[item.id];
        return next;
      });
    }
  };

  const start = async () => {
    setBusy(true);
    setMsg(null);
    setExit(null);
    const f: Record<string, boolean | number | string> = {};
    for (const [key] of FLAG_DEFS) if (flags[key]) f[key] = true;
    // collide and orbit are mutually exclusive; orbit (when set) wins and the
    // dial is forced off, mirroring the engine's ref-to-run-both guard.
    if (orbitOn) f.orbit = orbit.trim();
    else if (temp > 0) f.collision_temp = temp / 100; // 0 must be OMITTED — baseline
    if (model) f.model = model; // upstream reads flags.model (how the standalone app passes it)
    try {
      const { status, body } = await startResearch(f);
      if (status === 409) {
        // single-flight: someone beat us to it — that's a state, join the live console
        setMsg({ text: 'already running', isError: false });
        setOverride(true);
      } else if (body?.ok) {
        startedRef.current = body.started ?? null;
        setStartedAt(body.started ?? null);
        linesRef.current = 0;
        setLog([]);
        setPartial('');
        stickRef.current = true;
        setOverride(true);
        // Mining completes before /research/start returns; refresh the review
        // queue immediately instead of waiting for the next itch collector poll.
        getGrounding().then(setGroundingState).catch(() => {});
      } else {
        setMsg({ text: body?.error ?? `start failed (${status})`, isError: true });
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setMsg(null);
    setExit(null);
    try {
      const { status, body } = await resumeResearch();
      if (status === 409) {
        setMsg({ text: body?.error ?? 'nothing to resume', isError: false });
      } else if (body?.ok) {
        startedRef.current = body.started ?? null;
        setStartedAt(body.started ?? null);
        linesRef.current = 0;
        setLog([]);
        setPartial('');
        stickRef.current = true;
        setOverride(true);
        getGrounding().then(setGroundingState).catch(() => {});
      } else {
        setMsg({ text: body?.error ?? `resume failed (${status})`, isError: true });
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    // two-click arm — stop kills a live research
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    setBusy(true);
    try {
      const { status, body } = await stopResearch();
      if (status === 409) setOverride(false); // nothing running — quiet state
      else if (!body?.ok) setMsg({ text: body?.error ?? `stop failed (${status})`, isError: true });
      // on ok the next poll observes running=false and renders the exit line
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setBusy(false);
    }
  };

  const pendingGrounding = groundingState?.pending ?? [];
  const groundingReview = (pendingGrounding.length > 0 || feedbackErr || groundingState?.error) ? (
    <div className="fade-in mt-3 rounded-lg border border-amber/30 bg-amber/10 p-2.5">
      <div className="mb-2 flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
        <span className="shrink-0 uppercase tracking-[0.14em] text-amber">sxc review</span>
        {(groundingState?.threshold ?? 0) > 0 && (
          <span className="shrink-0 text-mist-faint">confidence &lt; {(groundingState?.threshold ?? 0).toFixed(1)}</span>
        )}
        {groundingState?.retriever && <span className="shrink-0 text-mist-faint">via {groundingState.retriever}</span>}
        <span className="min-w-0 flex-1 truncate text-mist-faint">thumbs adjust similar future grounding hits</span>
        {(groundingState?.reviewedTotal ?? 0) > 0 && (
          <span className="shrink-0 tabular-nums text-mist-faint">{groundingState?.reviewedTotal ?? 0} learned</span>
        )}
      </div>
      <div className="space-y-2">
        {pendingGrounding.slice(0, 3).map((item) => {
          const fbBusy = !!feedbackBusy[item.id];
          const where = item.project ? `${item.source}/${item.project}` : item.source;
          return (
            <div key={item.id} className="rounded-md border border-white/10 bg-white/[0.03] p-2">
              <div className="mb-1 flex min-w-0 items-center gap-2 font-mono text-[11px]">
                <span className="min-w-0 truncate text-mist" title={item.seed}>
                  “{item.seed}”
                </span>
                <span className="shrink-0 text-mist-faint">→</span>
                <span className="min-w-0 truncate text-mist-dim" title={`${where} · ${item.sessionId}`}>
                  {where}
                </span>
                <span className="shrink-0 tabular-nums text-amber" title={`raw sxc score ${item.confidence}, gate ${item.threshold}`}>
                  {Number.isFinite(item.confidence) ? item.confidence.toFixed(1) : String(item.confidence)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={fbBusy}
                    aria-label={`mark ${item.seed} grounding relevant`}
                    title="relevant — boost this/similar future sxc hits"
                    onClick={() => void submitGroundingFeedback(item, 'up')}
                    className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-mist-faint transition-colors hover:text-jade disabled:opacity-40"
                  >
                    👍
                  </button>
                  <button
                    type="button"
                    disabled={fbBusy}
                    aria-label={`mark ${item.seed} grounding irrelevant`}
                    title="not relevant — down-weight this/similar future sxc hits"
                    onClick={() => void submitGroundingFeedback(item, 'down')}
                    className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-mist-faint transition-colors hover:text-coral disabled:opacity-40"
                  >
                    👎
                  </button>
                </span>
              </div>
              <div className="max-h-10 overflow-hidden text-xs leading-relaxed text-mist-dim" title={item.quote}>
                {item.quote}
              </div>
            </div>
          );
        })}
      </div>
      {pendingGrounding.length > 3 && (
        <div className="mt-1.5 font-mono text-[11px] text-mist-faint">+{pendingGrounding.length - 3} more queued</div>
      )}
      {(feedbackErr || groundingState?.error) && (
        <div className="mt-1.5 truncate font-mono text-[11px] text-coral" title={feedbackErr ?? groundingState?.error ?? undefined}>
          {feedbackErr ?? groundingState?.error}
        </div>
      )}
    </div>
  ) : null;

  if (running) {
    return (
      <section className="panel-surface rise mb-4 px-4 py-3 xl:px-5" style={{ '--rise-i': 0 } as CSSProperties}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 breathe">
            <Dot status="running" />
          </span>
          <span className="text-sm font-semibold text-mist">Research running</span>
          <RelTime iso={startedAt} />
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={() => void stop()}
            className={`cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] press glass-hover ${
              armed ? 'glass-raised text-coral hover:text-coral' : 'glass text-mist-faint hover:text-mist'
            }`}
          >
            {busy ? '◌' : armed ? 'Stop now?' : 'Stop'}
          </button>
        </div>
        {msg && (
          <div
            className={`fade-in mt-1 truncate font-mono text-xs ${msg.isError ? 'text-coral' : 'text-mist-faint'}`}
            title={msg.text}
          >
            {msg.text}
          </div>
        )}
        {groundingReview}
        <div
          ref={logBoxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
            if (glidingRef.current) {
              // our own glide settling — don't read it as user scrollback
              if (atBottom) glidingRef.current = false;
              return;
            }
            stickRef.current = atBottom;
          }}
          onWheel={() => {
            glidingRef.current = false;
          }}
          onTouchMove={() => {
            glidingRef.current = false;
          }}
          className="mt-2 max-h-72 overflow-y-auto overscroll-contain font-mono text-xs leading-relaxed"
        >
          {log.length === 0 && !partial && <div className="fade-in text-mist-faint">Waiting for research output…</div>}
          {log.map((l, i) => (
            <div key={i} className="fade-in whitespace-pre-wrap break-words text-mist-dim">
              {l}
            </div>
          ))}
          {partial && (
            <div className="stream-cursor whitespace-pre-wrap break-words text-mist-faint">{partial}</div>
          )}
          {pollDown && (
            <div className="fade-in text-coral">Live status is unavailable. Itch may be offline.</div>
          )}
        </div>
      </section>
    );
  }

  // idle: a calm launcher row — the exit line of the last finished run sits above it.
  // jade ONLY when it did work (saved a run); kills and failures are coral.
  const hasUnsavedResult = Boolean(
    exit && !exit.savedStem && !exit.killedReason && exit.code === 0 && (log.length > 0 || partial),
  );
  const exitView = exit
    ? exit.savedStem
      ? { tone: 'text-jade', text: `research finished — saved ${exit.savedStem}` }
      : exit.killedReason
        ? { tone: 'text-coral', text: `research stopped — ${exit.killedReason}` }
        : exit.code !== null && exit.code !== 0
          ? { tone: 'text-coral', text: `research exited (${exit.code})` }
          : { tone: 'text-mist-faint', text: hasUnsavedResult ? 'research finished — unsaved result below' : 'research finished — nothing saved' }
    : research.resumable
      ? { tone: 'text-coral', text: 'interrupted research checkpoint available' }
      : null;
  const canResume = exit?.resumable || research.resumable;

  return (
    <section className="panel-surface rise mb-4 px-4 py-3 xl:px-5" style={{ '--rise-i': 0 } as CSSProperties}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-mist">Research setup</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mist-faint">idea finder</span>
      </div>
      {exitView && (
        <div className="fade-in mb-2 flex items-center gap-2">
          <span className={`font-mono text-xs ${exitView.tone}`}>{exitView.text}</span>
          {canResume && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void resume()}
              title="continue the interrupted run from its partial ideas — no re-research"
              className="cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] text-jade press glass glass-hover hover:text-jade disabled:opacity-50"
            >
              {busy ? '◌' : 'Resume'}
            </button>
          )}
        </div>
      )}
      {msg && (
        <div
          className={`fade-in mb-2 truncate font-mono text-xs ${msg.isError ? 'text-coral' : 'text-mist-faint'}`}
          title={msg.text}
        >
          {msg.text}
        </div>
      )}
      {hasUnsavedResult && (
        <div
          ref={logBoxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
            if (glidingRef.current) {
              if (atBottom) glidingRef.current = false;
              return;
            }
            stickRef.current = atBottom;
          }}
          onWheel={() => {
            glidingRef.current = false;
          }}
          onTouchMove={() => {
            glidingRef.current = false;
          }}
          className="mb-3 max-h-72 overflow-y-auto overscroll-contain font-mono text-xs leading-relaxed"
        >
          {log.map((l, i) => (
            <div key={i} className="fade-in whitespace-pre-wrap break-words text-mist-dim">
              {l}
            </div>
          ))}
          {partial && (
            <div className="stream-cursor whitespace-pre-wrap break-words text-mist-faint">{partial}</div>
          )}
        </div>
      )}
      {groundingReview && <div className="mb-3">{groundingReview}</div>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="sr-only">Research options</span>
        {FLAG_DEFS.map(([key, label]) => (
          <label
            key={key}
            className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-mist-dim transition-colors hover:text-mist"
          >
            <input
              type="checkbox"
              checked={flags[key]}
              onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))}
              className="h-3 w-3 cursor-pointer accent-mist-dim"
            />
            {label}
          </label>
        ))}
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-mist-dim">
          <span className="text-mist-faint">Explore</span>
          <input
            type="range"
            min={0}
            max={100}
            value={temp}
            disabled={orbitOn}
            onChange={(e) => setTemp(Number(e.target.value))}
            aria-label="Exploration level"
            title={orbitOn ? 'Exploration is unavailable while a focus is set.' : 'Increase how far the research moves from familiar ground.'}
            className="range-glass w-24 disabled:opacity-40"
          />
          <span className="w-8 tabular-nums">{(shownTemp / 100).toFixed(2)}</span>
        </label>
        <label
          className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11px] text-mist-dim"
          title={
            collideOn
              ? 'disabled while collide is set (they are opposites)'
              : 'focus this run around a center you name — a theme, tech, problem, or half-formed idea'
          }
        >
          <span className="text-mist-faint">Focus</span>
          <input
            type="text"
            value={orbit}
            disabled={collideOn}
            onChange={(e) => setOrbit(e.target.value)}
            placeholder="Theme, technology, problem, or half-formed idea…"
            aria-label="Research focus"
            maxLength={4000}
            className="glass min-w-0 flex-1 px-2 py-1 text-mist outline-none placeholder:text-mist-faint disabled:opacity-40"
          />
        </label>
        <span className="flex w-full flex-col gap-2 sm:ml-auto sm:w-auto sm:flex-row sm:items-center sm:gap-3">
          <label
            className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-mist-dim transition-colors hover:text-mist"
            title="force itch-intent mining onto bm25 — use while the ColBERT index is stale or rebuilding; off uses ColBERT"
          >
            <input
              type="checkbox"
              checked={fallbackBm25}
              onChange={(e) => void toggleFallback(e.target.checked)}
              className="h-3 w-3 cursor-pointer accent-mist-dim"
            />
            <span className={fallbackBm25 ? 'text-amber' : undefined}>Use BM25 fallback</span>
          </label>
          {models && model !== null && (
            <select
              value={model}
              title="Research model"
              onChange={(e) => {
                const id = e.target.value;
                setModelId(id);
                // best-effort upstream pref — start passes flags.model explicitly anyway
                persistModel(id).catch(() => {});
              }}
              className="glass glass-hover w-full max-w-full cursor-pointer truncate px-2 py-2 font-mono text-[13px] text-mist outline-none [color-scheme:dark] sm:max-w-72 sm:py-1 sm:text-[11px]"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className="cursor-pointer rounded-md px-3 py-2 font-mono text-[12px] text-mist-dim press glass glass-hover hover:text-mist disabled:opacity-50 sm:px-2 sm:py-0.5 sm:text-[11px]"
          >
            {busy ? '◌' : 'Start research'}
          </button>
        </span>
      </div>
    </section>
  );
}
