import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Dot, RelTime } from '../../components/ui';
import { useTweenNumber } from '../../hooks';
import { getModels, getResearchStatus, setModel as persistModel, startResearch, stopResearch } from './api';
import type { ItchResearch } from '../../../../shared/types';

// ---------- research strip (rise 0) ----------

const FLAG_DEFS = [
  ['no_gh', 'skip github scan'],
  ['no_local', 'skip local scan'],
  ['fresh', 'ignore prior runs (fresh)'],
  ['no_history', 'no history'],
  ['market', 'market lens'],
] as const;

type FlagKey = (typeof FLAG_DEFS)[number][0];

interface ExitInfo {
  code: number | null;
  savedStem: string | null;
  killedReason: string | null;
}

export function ResearchStrip({
  research,
  onSaved,
}: {
  research: ItchResearch;
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

  // model picker — null until /models answers; load failure keeps it hidden (upstream default applies)
  const [models, setModels] = useState<{ id: string; label?: string }[] | null>(null);
  const [model, setModelId] = useState<string | null>(null);

  const linesRef = useRef(0); // absolute log lines we hold (the delta protocol's `since`)
  const pollFailsRef = useRef(0);
  const startedRef = useRef<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true); // auto-scroll only while the user is at the bottom
  // our own smooth scrollTo emits intermediate scroll events that read as "not at
  // bottom" — they must not unstick the follow; wheel/touch hand control back
  const glidingRef = useRef(false);

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
          setExit({ code: st.exit_code, savedStem: st.saved_stem, killedReason: st.killed_reason });
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
      } else {
        setMsg({ text: body?.error ?? `start failed (${status})`, isError: true });
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

  if (running) {
    return (
      <section className="glass rise mb-4 px-4 py-3 xl:px-5" style={{ '--rise-i': 0 } as CSSProperties}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 breathe">
            <Dot status="running" />
          </span>
          <span className="text-sm lowercase text-mist">research running</span>
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
            {busy ? '◌' : armed ? 'sure?' : 'stop'}
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
          {log.length === 0 && !partial && <div className="fade-in text-mist-faint">waiting for output…</div>}
          {log.map((l, i) => (
            <div key={i} className="fade-in whitespace-pre-wrap break-words text-mist-dim">
              {l}
            </div>
          ))}
          {partial && (
            <div className="stream-cursor whitespace-pre-wrap break-words text-mist-faint">{partial}</div>
          )}
          {pollDown && (
            <div className="fade-in text-coral">status poll failing — itch server unreachable?</div>
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
    : null;

  return (
    <section className="glass rise mb-4 px-4 py-3 xl:px-5" style={{ '--rise-i': 0 } as CSSProperties}>
      {exitView && <div className={`fade-in mb-2 font-mono text-xs ${exitView.tone}`}>{exitView.text}</div>}
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">
          new research
        </span>
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
          <span className="text-mist-faint">collide</span>
          <input
            type="range"
            min={0}
            max={100}
            value={temp}
            disabled={orbitOn}
            onChange={(e) => setTemp(Number(e.target.value))}
            aria-label="collide temperature"
            title={orbitOn ? 'disabled while orbit is set (they are opposites)' : 'chaos dial — zero stays baseline'}
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
          <span className="text-mist-faint">orbit</span>
          <input
            type="text"
            value={orbit}
            disabled={collideOn}
            onChange={(e) => setOrbit(e.target.value)}
            placeholder="focus around… (theme / tech / problem)"
            aria-label="orbit center"
            maxLength={4000}
            className="glass min-w-0 flex-1 px-2 py-1 text-mist outline-none placeholder:text-mist-faint disabled:opacity-40"
          />
        </label>
        <span className="ml-auto flex items-center gap-3">
          {models && model !== null && (
            <select
              value={model}
              title="model for research + side tools"
              onChange={(e) => {
                const id = e.target.value;
                setModelId(id);
                // best-effort upstream pref — start passes flags.model explicitly anyway
                persistModel(id).catch(() => {});
              }}
              className="glass glass-hover max-w-72 cursor-pointer truncate px-2 py-1 font-mono text-[11px] text-mist outline-none [color-scheme:dark]"
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
            className="cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] text-mist-dim press glass glass-hover hover:text-mist disabled:opacity-50"
          >
            {busy ? '◌' : 'start research'}
          </button>
        </span>
      </div>
    </section>
  );
}
