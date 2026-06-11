import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { refreshSection } from '../api';
import { Markdown } from '../components/markdown';
import { CopyText, Dot, EmptyState, Panel, RelTime, Row, SectionLabel } from '../components/ui';
import type { ItchResearch, ItchRunInfo, ItchState, Snapshot } from '../../../shared/types';

// itch — the idea scout, folded into the dashboard. everything below talks to the
// local itch ui server through the atrium proxy at /api/itch/* (same origin; the
// proxy injects the csrf header and strips browser origin/referer server-side).

// ---------- upstream shapes (proxied 1:1 from the itch server) ----------

interface IdeaMeta {
  collide?: boolean;
  sampled_domain?: string;
  bridge?: string;
  source_urls?: string[];
}

interface RunIdea {
  idx: number;
  title: string;
  body: string;
  metadata: IdeaMeta;
  rating: number | null;
  note: string | null;
  outcome: string | null;
  outcome_note: string | null;
}

interface RunDetail {
  stem: string;
  preamble: string;
  footer: string;
  ideas: RunIdea[];
}

interface Decision {
  title: string;
  rating: number;
  note: string | null;
  as_of: string;
  age: number;
  metadata: IdeaMeta;
}

interface SearchHit {
  stem: string;
  idx: number;
  title: string;
  snippet: string;
  rating: number | null;
  note: string | null;
  as_of: string;
}

interface ResearchStatus {
  running: boolean;
  started: string | null;
  log: string[];
  log_offset: number;
  log_truncated: boolean;
  partial: string;
  lines: number;
  exit_code: number | null;
  saved_stem: string | null;
  killed_reason: string | null;
}

// ---------- tiny typed fetch helpers ----------

const BASE = '/api/itch';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `itch ${res.status}`);
  // an aborted body read on an OK response resolves null — re-raise it as the abort
  // it is, so callers' abort guards swallow it instead of rendering null data
  if (body === null) throw new DOMException('aborted', 'AbortError');
  return body as T;
}

/** mutations return the status so callers can treat 409 as a state, not a failure. */
async function mutate(
  method: 'POST' | 'PUT',
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: { ok?: boolean; error?: string; started?: string } | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(payload !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------- display helpers ----------

const COLLIDE_PREFIX_RE = /^\[collide\]\s*/;

/** display title only — ratings are title-keyed and must send the ORIGINAL string. */
function displayTitle(t: string): string {
  return t.replace(COLLIDE_PREFIX_RE, '');
}

/** "20260608-170934" → "2026-06-08 17:09" */
function fmtStem(stem: string): string {
  const m = stem.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : stem;
}

const RATING_LABEL: Record<number, string> = {
  1: 'drop',
  2: 'cool',
  3: 'neutral',
  4: 'interested',
  5: 'pursuing',
};

/** "n/m" = ideas/rated — labels must stay short enough for the run picker. */
function runLabel(r: ItchRunInfo): string {
  let s = `${fmtStem(r.stem)} · ${r.nIdeas}/${r.nRated}`;
  if (r.isCollide) s += ` · collide ${(r.collisionTemp ?? 0).toFixed(2)}`;
  if (r.baselineFor) s += ' · baseline';
  return s;
}

interface ScrollTarget {
  stem: string;
  idx?: number;
  title?: string; // decisions rows know titles, not indices — the feed resolves it
}

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

function ResearchStrip({
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
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [exit, setExit] = useState<ExitInfo | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(research.started);
  const [log, setLog] = useState<string[]>([]);
  const [partial, setPartial] = useState('');
  const [pollDown, setPollDown] = useState(false); // 3+ consecutive status-poll failures

  const linesRef = useRef(0); // absolute log lines we hold (the delta protocol's `since`)
  const pollFailsRef = useRef(0);
  const startedRef = useRef<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true); // auto-scroll only while the user is at the bottom

  // a run started elsewhere (cli, another tab): snapshot's started changes → follow it again
  const prevStartedProp = useRef(research.started);
  useEffect(() => {
    if (research.started !== prevStartedProp.current) {
      prevStartedProp.current = research.started;
      if (research.started !== null) setOverride(null);
    }
  }, [research.started]);

  // status poll — 2s setTimeout chain while mounted and running; aborts on unmount
  useEffect(() => {
    if (!running) return;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let gone = false;
    const tick = async () => {
      try {
        const st = await getJson<ResearchStatus>(`/research/status?since=${linesRef.current}`, ac.signal);
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

  // follow the feed only when the user already sits at the bottom — never fight scrollback
  useEffect(() => {
    const el = logBoxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [log, partial]);

  const start = async () => {
    setBusy(true);
    setMsg(null);
    setExit(null);
    const f: Record<string, boolean | number> = {};
    for (const [key] of FLAG_DEFS) if (flags[key]) f[key] = true;
    if (temp > 0) f.collision_temp = temp / 100; // 0 must be OMITTED — baseline
    try {
      const { status, body } = await mutate('POST', '/research/start', { flags: f });
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
      const { status, body } = await mutate('POST', '/research/stop');
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
          <Dot status="active" />
          <span className="text-sm lowercase text-mist">research running</span>
          <RelTime iso={startedAt} />
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={() => void stop()}
            className={`cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] text-coral transition-colors hover:text-coral ${
              armed ? 'glass-raised' : 'glass'
            }`}
          >
            {busy ? '◌' : armed ? 'sure?' : 'stop'}
          </button>
        </div>
        {msg && (
          <div
            className={`mt-1 truncate font-mono text-xs ${msg.isError ? 'text-coral' : 'text-mist-faint'}`}
            title={msg.text}
          >
            {msg.text}
          </div>
        )}
        <div
          ref={logBoxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
          }}
          className="mt-2 max-h-72 overflow-y-auto font-mono text-xs leading-relaxed"
        >
          {log.length === 0 && !partial && <div className="text-mist-faint">waiting for output…</div>}
          {log.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-words text-mist-dim">
              {l}
            </div>
          ))}
          {partial && <div className="whitespace-pre-wrap break-words text-mist-faint">{partial}</div>}
          {pollDown && <div className="text-coral">status poll failing — itch server unreachable?</div>}
        </div>
      </section>
    );
  }

  // idle: a calm launcher row — the exit line of the last finished run sits above it.
  // jade ONLY when it did work (saved a run); kills and failures are coral.
  const exitView = exit
    ? exit.savedStem
      ? { tone: 'text-jade', text: `research finished — saved ${exit.savedStem}` }
      : exit.killedReason
        ? { tone: 'text-coral', text: `research stopped — ${exit.killedReason}` }
        : exit.code !== null && exit.code !== 0
          ? { tone: 'text-coral', text: `research exited (${exit.code})` }
          : { tone: 'text-mist-faint', text: 'research finished — nothing saved' }
    : null;

  return (
    <section className="glass rise mb-4 px-4 py-3 xl:px-5" style={{ '--rise-i': 0 } as CSSProperties}>
      {exitView && <div className={`mb-2 font-mono text-xs ${exitView.tone}`}>{exitView.text}</div>}
      {msg && (
        <div
          className={`mb-2 truncate font-mono text-xs ${msg.isError ? 'text-coral' : 'text-mist-faint'}`}
          title={msg.text}
        >
          {msg.text}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">
          new research
        </span>
        {FLAG_DEFS.map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-mist-dim">
            <input
              type="checkbox"
              checked={flags[key]}
              onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))}
              className="h-3 w-3 accent-mist-dim"
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
            onChange={(e) => setTemp(Number(e.target.value))}
            className="w-24 accent-mist-dim"
          />
          <span className="w-8 tabular-nums">{(temp / 100).toFixed(2)}</span>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void start()}
          className="ml-auto cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] text-mist-dim transition-colors glass hover:text-mist"
        >
          {busy ? '◌' : 'start research'}
        </button>
      </div>
    </section>
  );
}

// ---------- idea cards (the feed, rise 2) ----------

function RatingButtons({
  rating,
  pending,
  onRate,
}: {
  rating: number | null;
  pending: number | null; // the button whose PUT is in flight — all five disable
  onRate: (n: number) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          title={RATING_LABEL[n]}
          disabled={pending !== null}
          onClick={() => onRate(n)}
          className={`h-6 w-6 cursor-pointer rounded text-center font-mono text-[11px] tabular-nums transition-colors ${
            rating === n ? 'glass-raised text-mist' : 'text-mist-faint hover:text-mist'
          }`}
        >
          {pending === n ? '…' : n}
        </button>
      ))}
    </span>
  );
}

function IdeaCard({ idea, onRated }: { idea: RunIdea; onRated: () => void }) {
  const [rating, setRating] = useState(idea.rating);
  const [note, setNote] = useState(idea.note ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showBridge, setShowBridge] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<number | null>(null); // in-flight rating PUT
  const [collapsible, setCollapsible] = useState(false);
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRef = useRef(false); // escape pressed — blur must not save
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(
    () => () => {
      if (failTimer.current) clearTimeout(failTimer.current);
    },
    [],
  );

  // collapsible = the RENDERED body overflows the 144px (max-h-36) clamp — raw-text
  // heuristics mismatch rendered height. Compare against the fixed cap so the check
  // holds whether or not the clamp is currently applied; ResizeObserver re-checks
  // because layout is fluid. +1 forgives sub-pixel rounding.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setCollapsible(el.scrollHeight > 144 + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [idea.body]);

  const flashFail = () => {
    setFailed(true);
    if (failTimer.current) clearTimeout(failTimer.current);
    failTimer.current = setTimeout(() => setFailed(false), 2500);
  };

  // title-keyed upsert — MUST send the ORIGINAL exact title (with any '[collide] ' prefix)
  const rate = async (n: number) => {
    if (pending !== null) return; // single-flight — concurrent title-keyed PUTs have no order
    const prev = rating;
    const next = rating === n ? null : n; // clicking the current rating clears it
    setPending(n);
    setRating(next); // optimistic
    try {
      const { body } = await mutate('PUT', '/rating', { title: idea.title, rating: next });
      if (!body?.ok) throw new Error(body?.error ?? 'rating failed');
      onRated();
    } catch {
      setRating(prev);
      flashFail();
    } finally {
      setPending(null);
    }
  };

  const saveNote = async () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setEditing(false);
      return;
    }
    setEditing(false);
    const next = draft.trim();
    if (next === note) return;
    const prev = note;
    setNote(next); // optimistic
    try {
      const { body } = await mutate('PUT', '/rating', {
        title: idea.title,
        note: next === '' ? null : next,
      });
      if (!body?.ok) throw new Error(body?.error ?? 'note failed');
      onRated();
    } catch {
      setNote(prev);
      flashFail();
    }
  };

  const meta = idea.metadata ?? {};
  const collide = meta.collide || COLLIDE_PREFIX_RE.test(idea.title);

  return (
    <section data-idx={idea.idx} className="glass p-4">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <CopyText text={idea.title}>
            <span className="text-sm font-semibold text-mist">{displayTitle(idea.title)}</span>
          </CopyText>
        </div>
        {collide && (
          <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-dim">
            collide
          </span>
        )}
        {meta.sampled_domain && (
          <span
            className="max-w-36 shrink-0 truncate rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-faint"
            title={`sampled domain: ${meta.sampled_domain}`}
          >
            {meta.sampled_domain}
          </span>
        )}
        {failed && <span className="shrink-0 font-mono text-[11px] text-coral">failed</span>}
        <RatingButtons rating={rating} pending={pending} onRate={(n) => void rate(n)} />
      </div>

      {/* collapsed to ~6 lines — cards are long, the feed must scan; the bottom fade
          says "there's more" so the cut reads intentional, not broken */}
      <div
        ref={bodyRef}
        className={`mt-1 ${
          collapsible && !expanded
            ? 'max-h-36 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]'
            : ''
        }`}
      >
        <Markdown content={idea.body} className="text-sm [&_p]:text-mist-dim [&_li]:text-mist-dim" />
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 cursor-pointer font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}

      {/* notes become avoid-flavor steers in the engine — only on rated cards */}
      {rating !== null && (
        <div className="mt-2">
          {editing ? (
            <textarea
              autoFocus
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void saveNote()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  cancelRef.current = true;
                  e.currentTarget.blur();
                }
              }}
              placeholder="note — becomes a steer for future runs"
              className="glass w-full resize-y px-2 py-1.5 font-mono text-xs text-mist outline-none placeholder:text-mist-faint"
            />
          ) : (
            <div className="group flex min-w-0 items-baseline gap-2">
              {note ? (
                <span className="min-w-0 truncate text-xs text-mist-dim" title={note}>
                  {note}
                </span>
              ) : (
                <span className="text-xs text-mist-faint">no note</span>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraft(note);
                  cancelRef.current = false;
                  setEditing(true);
                }}
                className="hover-cluster shrink-0 cursor-pointer font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
              >
                edit
              </button>
            </div>
          )}
        </div>
      )}

      {meta.bridge && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowBridge((v) => !v)}
            className="cursor-pointer font-mono text-xs text-mist-faint transition-colors hover:text-mist"
          >
            {showBridge ? '▾ bridge' : '▸ bridge'}
          </button>
          {showBridge && (
            <div className="mt-1 font-mono text-xs leading-relaxed text-mist-faint">
              <div className="whitespace-pre-wrap break-words">{meta.bridge}</div>
              {(meta.source_urls?.length ?? 0) > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {meta.source_urls?.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-slate-glow hover:underline"
                    >
                      {u.replace(/^https?:\/\//, '')}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Feed({
  runs,
  selectedStem,
  onSelect,
  scrollTarget,
  onRated,
}: {
  runs: ItchRunInfo[];
  selectedStem: string | null;
  onSelect: (stem: string) => void;
  scrollTarget: ScrollTarget | null;
  onRated: () => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); // transient — jump target missing
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedStem) {
      setDetail(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    getJson<RunDetail>(`/run/${encodeURIComponent(selectedStem)}`, ac.signal)
      .then((d) => {
        setDetail(d);
        setLoading(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => ac.abort();
  }, [selectedStem]);

  // jump from search/decisions: once the right run is loaded, scroll to the card
  useEffect(() => {
    if (!scrollTarget || !detail || detail.stem !== scrollTarget.stem) return;
    const idx = scrollTarget.idx ?? detail.ideas.find((i) => i.title === scrollTarget.title)?.idx;
    if (idx === undefined) {
      // the jump resolved to a run that doesn't hold the idea — say so, quietly
      setNotice('not found in this run');
      const t = setTimeout(() => setNotice(null), 4000);
      return () => clearTimeout(t);
    }
    const raf = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-idx="${idx}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollTarget, detail]);

  const stale = selectedStem !== null && !runs.some((r) => r.stem === selectedStem);

  return (
    <Panel
      title="ideas"
      riseIndex={2}
      className="mb-4"
      right={
        runs.length > 0 || stale ? (
          <select
            value={selectedStem ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            className="glass max-w-96 cursor-pointer px-2 py-1 font-mono text-[11px] text-mist outline-none"
          >
            {/* a just-saved run can outrun the snapshot — keep it selectable until the refresh lands */}
            {stale && selectedStem && <option value={selectedStem}>{fmtStem(selectedStem)} · new</option>}
            {runs.map((r) => (
              <option key={r.stem} value={r.stem}>
                {runLabel(r)}
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      {notice && <div className="mb-2 px-2.5 font-mono text-xs text-mist-faint">{notice}</div>}
      {error ? (
        <div className="px-2.5 py-2 font-mono text-xs text-coral">{error}</div>
      ) : !selectedStem ? (
        <EmptyState>no runs yet — start a research above</EmptyState>
      ) : loading ? (
        <EmptyState>loading run…</EmptyState>
      ) : detail && detail.ideas.length === 0 ? (
        <EmptyState>run has no ideas</EmptyState>
      ) : detail ? (
        <div ref={listRef} className="space-y-3">
          {/* preamble/footer carry the model's ranking commentary — quiet, not cards */}
          {detail.preamble.trim() !== '' && (
            <Markdown
              content={detail.preamble}
              className="text-sm text-mist-faint [&_p]:text-mist-faint [&_li]:text-mist-faint"
            />
          )}
          {detail.ideas.map((i) => (
            <IdeaCard key={`${detail.stem}-${i.idx}`} idea={i} onRated={onRated} />
          ))}
          {detail.footer.trim() !== '' && (
            <Markdown
              content={detail.footer}
              className="text-sm text-mist-faint [&_p]:text-mist-faint [&_li]:text-mist-faint"
            />
          )}
        </div>
      ) : null}
    </Panel>
  );
}

// ---------- search (rise 1, slim — sits above the feed it jumps into) ----------

function SearchStrip({ onJump }: { onJump: (stem: string, idx: number) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = q.trim();
    setError(null);
    if (query.length < 2) {
      setHits([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      getJson<SearchHit[]>(`/search?q=${encodeURIComponent(query)}`, ac.signal)
        .then(setHits)
        .catch((e) => {
          if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
        });
    }, 300);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  const shown = hits.slice(0, 20);

  return (
    <section className="glass rise mb-4 px-4 py-3 xl:px-5" style={{ '--rise-i': 1 } as CSSProperties}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search ideas…"
        className="w-full bg-transparent px-0.5 py-0.5 font-mono text-sm text-mist outline-none placeholder:text-mist-faint"
      />
      {error && <div className="mt-1 px-1.5 font-mono text-xs text-coral">{error}</div>}
      {q.trim().length >= 2 && !error && (
        <div className="mt-1">
          {shown.length === 0 ? (
            <div className="px-1.5 py-1 text-xs text-mist-faint">no matches</div>
          ) : (
            <>
              {shown.map((h) => (
                <Row key={`${h.stem}-${h.idx}`} onClick={() => onJump(h.stem, h.idx)} className="group">
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-sm text-mist"
                      title={`${displayTitle(h.title)} — ${h.snippet}`}
                    >
                      {displayTitle(h.title)}
                    </span>
                    {h.rating !== null && (
                      <span
                        className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-dim"
                        title={RATING_LABEL[h.rating]}
                      >
                        {h.rating}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[11px] text-mist-faint">{fmtStem(h.stem)}</span>
                  </div>
                </Row>
              ))}
              {hits.length > shown.length && (
                <div className="px-2.5 py-1 font-mono text-[11px] tabular-nums text-mist-faint">
                  {hits.length - shown.length} more — narrow the query
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- decisions ledger (rise 3) ----------

function DecisionsPanel({
  runs,
  version,
  onJump,
}: {
  runs: ItchRunInfo[];
  version: number;
  onJump: (stem: string, title: string) => void;
}) {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null); // transient — jump resolve failed
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const ac = new AbortController();
    getJson<Decision[]>('/decisions', ac.signal)
      .then((d) => {
        setDecisions(d);
        setError(null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [version]);

  const liveStems = useMemo(() => new Set(runs.map((r) => r.stem)), [runs]);
  const groups = [5, 4, 3, 2, 1]
    .map((r) => ({ rating: r, rows: (decisions ?? []).filter((d) => d.rating === r) }))
    .filter((g) => g.rows.length > 0);
  // count what's actually grouped below — the snapshot's ratedTotal is 60s-stale
  // and counts cleared (null-rating) entries too
  const ratedCount = decisions === null ? null : decisions.filter((d) => d.rating >= 1 && d.rating <= 5).length;

  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  };

  // as_of is stamped with the NEWEST stem on every re-rate, so it often does NOT
  // contain the idea — resolve the containing run via search first; as_of is the
  // fallback, and only when both fail does the row admit defeat (quietly).
  const jump = async (d: Decision) => {
    try {
      const hits = await getJson<SearchHit[]>(`/search?q=${encodeURIComponent(d.title)}`);
      const hit = hits.find((h) => h.title.toLowerCase() === d.title.toLowerCase());
      if (hit) {
        onJump(hit.stem, d.title);
        return;
      }
    } catch {
      // search down — fall through to the ledger's stamp
    }
    if (liveStems.has(d.as_of)) {
      onJump(d.as_of, d.title);
      return;
    }
    showNotice('not found in any run');
  };

  return (
    <Panel
      title="decisions"
      riseIndex={3}
      right={
        ratedCount !== null ? (
          <span className="font-mono text-xs tabular-nums text-mist-faint">{ratedCount}</span>
        ) : undefined
      }
    >
      {notice && <div className="mb-1 px-2.5 font-mono text-xs text-mist-faint">{notice}</div>}
      <div className="max-h-[28rem] overflow-y-auto">
        {error ? (
          <div className="px-2.5 py-2 font-mono text-xs text-coral">{error}</div>
        ) : decisions === null ? (
          <EmptyState>loading…</EmptyState>
        ) : groups.length === 0 ? (
          <EmptyState>no decisions yet — rate some ideas</EmptyState>
        ) : (
          groups.map(({ rating, rows }) => {
            const expanded = open[rating] ?? false;
            const shown = expanded ? rows : rows.slice(0, 6);
            return (
              <Fragment key={rating}>
                <SectionLabel>
                  {RATING_LABEL[rating]} <span className="tabular-nums">· {rows.length}</span>
                </SectionLabel>
                {shown.map((d) => (
                  <Row key={`${d.as_of}-${d.title}`} onClick={() => void jump(d)} className="group">
                    <div className="flex w-full min-w-0 items-center gap-2">
                      <span className="min-w-0 shrink truncate text-sm text-mist" title={displayTitle(d.title)}>
                        {displayTitle(d.title)}
                      </span>
                      {d.note && (
                        <span className="min-w-0 flex-1 truncate text-xs text-mist-faint" title={d.note}>
                          {d.note}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-mist-faint">
                        {fmtStem(d.as_of)}
                      </span>
                    </div>
                  </Row>
                ))}
                {rows.length > 6 && !expanded && (
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [rating]: true }))}
                    className="cursor-pointer px-2.5 py-1 font-mono text-[11px] tabular-nums text-mist-faint transition-colors hover:text-mist"
                  >
                    {rows.length - 6} more
                  </button>
                )}
              </Fragment>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ---------- panel root ----------

function ItchBody({ it }: { it: ItchState }) {
  const runs = it.runs;
  const [selectedStem, setSelectedStem] = useState<string | null>(runs[0]?.stem ?? null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);
  const [decisionsVersion, setDecisionsVersion] = useState(0);

  // adopt the newest run once the first snapshot with runs arrives
  useEffect(() => {
    if (selectedStem === null && runs.length > 0) setSelectedStem(runs[0].stem);
  }, [runs, selectedStem]);

  const jumpTo = useCallback((stem: string, idx?: number, title?: string) => {
    setSelectedStem(stem);
    setScrollTarget({ stem, idx, title });
  }, []);

  // decisions re-fetch after any rating/note change
  const onRated = useCallback(() => setDecisionsVersion((v) => v + 1), []);

  // research saved a run: select it and ask atrium to re-poll the itch section
  const onSaved = useCallback((stem: string) => {
    setSelectedStem(stem);
    setScrollTarget(null);
    void refreshSection('itch');
  }, []);

  return (
    <div>
      {!it.up && (
        // upstream unreachable — surface staleness, keep last-known data below
        <div className="mb-3 flex min-w-0 items-center gap-2 px-1 font-mono text-xs">
          <Dot status="error" />
          <span className="shrink-0 text-coral">itch server unreachable</span>
          {it.error && (
            <span className="min-w-0 truncate text-mist-faint" title={it.error}>
              {it.error}
            </span>
          )}
          <span className="shrink-0 text-mist-faint">— atrium restarts it</span>
          <span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-[11px] text-mist-faint">
            last data <RelTime iso={it.updatedAt} />
          </span>
        </div>
      )}
      {it.up && it.error && (
        <div className="mb-3 flex min-w-0 items-center gap-2 px-1 font-mono text-xs">
          <Dot status="error" />
          <span className="min-w-0 truncate text-coral" title={it.error}>
            {it.error}
          </span>
        </div>
      )}

      <ResearchStrip research={it.research} onSaved={onSaved} />
      <SearchStrip onJump={(stem, idx) => jumpTo(stem, idx)} />
      <Feed
        runs={runs}
        selectedStem={selectedStem}
        onSelect={(s) => {
          setSelectedStem(s);
          setScrollTarget(null);
        }}
        scrollTarget={scrollTarget}
        onRated={onRated}
      />
      <DecisionsPanel
        runs={runs}
        version={decisionsVersion}
        onJump={(stem, title) => jumpTo(stem, undefined, title)}
      />
    </div>
  );
}

export default function ItchPanel({ snapshot }: { snapshot: Snapshot }) {
  const it = snapshot.itch;
  // rollout skew: a web bundle ahead of a not-yet-restarted server has no itch section
  if (!it) {
    return (
      <Panel title="itch">
        <EmptyState>server snapshot has no itch section — restart the atrium daemon</EmptyState>
      </Panel>
    );
  }
  // never polled yet (failure paths always set error)
  if (!it.up && it.updatedAt === null && it.error === null) {
    return (
      <Panel title="itch">
        <EmptyState>waiting for first snapshot</EmptyState>
      </Panel>
    );
  }
  return <ItchBody it={it} />;
}
