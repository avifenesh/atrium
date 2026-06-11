import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refreshSection } from '../../api';
import { Markdown } from '../../components/markdown';
import { EmptyState, Panel } from '../../components/ui';
import {
  addIdea,
  clearFilters,
  deleteRun,
  getFilters,
  getRunDetail,
  type AgentFilterPlan,
  type RunDetail,
  type RunIdea,
} from './api';
import { IdeaCard } from './IdeaCard';
import { displayTitle, fmtStem, runLabel, structuredFor } from './util';
import type { ItchRunInfo } from '../../../../shared/types';

// ---------- the feed (rise 2) — run picker + preamble/cards/footer ----------

export interface ScrollTarget {
  stem: string;
  idx?: number;
  title?: string; // decisions rows know titles, not indices — the feed resolves it
}

/** hover-revealed two-click arm in the run picker row. delete is upstream-final
 *  for the run FILE only — the ratings ledger is deliberately preserved. */
function DeleteRunButton({ stem, onDeleted }: { stem: string; onDeleted: () => void }) {
  const [state, setState] = useState<'idle' | 'armed' | 'busy' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const click = async () => {
    if (state === 'busy') return;
    if (state !== 'armed') {
      setState('armed');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState((s) => (s === 'armed' ? 'idle' : s)), 4000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setState('busy');
    try {
      const { status, body } = await deleteRun(stem);
      if (status >= 400) throw new Error((body as { error?: string } | null)?.error ?? 'delete failed');
      // atrium's own snapshot route (NOT under /api/itch) — re-poll so the runs
      // list drops the stem before the picker falls back
      await refreshSection('itch');
      setState('idle');
      onDeleted();
    } catch {
      setState('failed');
      timer.current = setTimeout(() => setState('idle'), 4000);
    }
  };
  return (
    <button
      type="button"
      disabled={state === 'busy'}
      title="removes the run file — ratings ledger is preserved"
      onClick={() => void click()}
      className={`${state === 'idle' ? 'hover-cluster' : ''} shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        state === 'armed' || state === 'failed' ? 'text-coral hover:text-coral' : 'text-mist-faint hover:text-mist'
      }`}
    >
      {state === 'busy' ? '…' : state === 'failed' ? 'failed' : state === 'armed' ? 'sure?' : 'delete run'}
    </button>
  );
}

/** quiet '+ add idea' row at the end of the cards — expands to an inline form.
 *  the POST returns the FULL renumbered run payload; the parent swaps detail. */
function AddIdeaRow({ stem, onAdded }: { stem: string; onAdded: (d: RunDetail) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOpen(false);
    setTitle('');
    setBody('');
    setError(null);
  };

  const submit = async () => {
    const t = title.trim();
    if (t === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const b = body.trim();
      const { status, body: res } = await addIdea(stem, { title: t, ...(b !== '' ? { body: b } : {}) });
      if (status >= 400 || !res || !Array.isArray(res.ideas)) {
        setError(res?.error ?? `add failed (${status})`);
        return;
      }
      reset();
      onAdded(res);
    } catch (e) {
      // a rejected fetch must not leave the form dead — surface it inline
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer px-2.5 py-1 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
      >
        + add idea
      </button>
    );
  }
  return (
    <div
      className="glass unfold space-y-2 p-3"
      onKeyDown={(e) => {
        if (e.key === 'Escape') reset();
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="title"
        className="glass field-glow w-full px-2 py-1.5 font-mono text-xs text-mist outline-none placeholder:text-mist-faint"
      />
      <textarea
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="body — optional, markdown"
        className="glass field-glow w-full resize-y px-2 py-1.5 font-mono text-xs text-mist outline-none placeholder:text-mist-faint"
      />
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          disabled={busy || title.trim() === ''}
          onClick={() => void submit()}
          className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist disabled:cursor-default disabled:opacity-40"
        >
          {busy ? '…' : 'add'}
        </button>
        <span className="font-mono text-[11px] text-mist-faint">esc cancels</span>
        {error && (
          <span className="min-w-0 truncate font-mono text-[11px] text-coral" title={error}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

export function Feed({
  runs,
  selectedStem,
  onSelect,
  scrollTarget,
  onScrollTargetConsumed,
  onRated,
  onScoped,
  onRunDeleted,
  filtersVersion,
  onFiltersChanged,
}: {
  runs: ItchRunInfo[];
  selectedStem: string | null;
  /** null clears the selection — the shell re-adopts the newest run from the next snapshot */
  onSelect: (stem: string | null) => void;
  scrollTarget: ScrollTarget | null;
  /** the target is one-shot: the shell nulls it here, or a later detail swap
   *  (add/delete renumbers idx) would re-fire the scroll at the wrong card */
  onScrollTargetConsumed: () => void;
  onRated: () => void;
  /** a scope oneshot persisted a file — the shell bumps ScopesPanel's version */
  onScoped: () => void;
  /** the shell remembers the stem so a stale snapshot can't re-adopt it */
  onRunDeleted?: (stem: string) => void;
  /** bumped by the shell whenever the tools wrote a new filter plan upstream */
  filtersVersion: number;
  /** notify the shell after a successful clear here, so ToolsPanel's chip refetches */
  onFiltersChanged?: () => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); // transient — jump target missing
  const [filters, setFilters] = useState<AgentFilterPlan | null>(null);
  const [clearState, setClearState] = useState<'idle' | 'busy' | 'failed'>('idle');
  // last run deleted from here — keeps the '· new' stale option from resurrecting
  // it while the snapshot still lists it (cleared once a snapshot drops the stem)
  const [deletedStem, setDeletedStem] = useState<string | null>(null);
  // 'written' = as-authored (the default frame); 'score' reorders by the sidecar
  const [order, setOrder] = useState<'written' | 'score'>('written');
  // the card a jump just landed on — wears a decaying mist glow so the eye lands
  // with the scroll; cleared after the glow so a repeat jump re-triggers it
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // timer lives in a ref: the scroll effect that shows a notice also consumes the
  // scroll target, which re-runs the effect — a cleanup-owned timeout would be
  // cancelled before it could dismiss the notice
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => {
    setFlashIdx(null); // idx is run-relative — a stale glow must not land on a stranger
    setOrder('written'); // sort is a per-run lens — a new run must not inherit it
    if (!selectedStem) {
      setDetail(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    getRunDetail(selectedStem, ac.signal)
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

  // agent filter plan — fetched on mount and whenever the tools rewrite it upstream
  useEffect(() => {
    const ac = new AbortController();
    getFilters(ac.signal)
      .then(setFilters)
      .catch(() => {
        /* filters are an overlay — a failed fetch just means unfiltered */
      });
    return () => ac.abort();
  }, [filtersVersion]);

  // add/delete-idea return the FULL renumbered run — swap it in only if the user
  // still looks at that run (the request may resolve after a picker change)
  const adoptRun = useCallback((d: RunDetail) => {
    setDetail((cur) => (cur && cur.stem === d.stem ? d : cur));
  }, []);

  // apply the agent filter plan client-side: exact-title hides, case-insensitive
  // term hides over title+body, boosted ideas float to the top (order preserved
  // within each half)
  const { shownIdeas, hiddenCount, filterActive } = useMemo(() => {
    const ideas = detail?.ideas ?? [];
    // the LLM strips the '[collide] ' prefix from plan titles despite instructions,
    // so plan entries may arrive stripped or prefixed — index both forms and test
    // both the idea's original title and its displayTitle against the set
    const hideTitles = new Set<string>();
    for (const t of filters?.hide_titles ?? []) {
      hideTitles.add(t);
      hideTitles.add(displayTitle(t));
    }
    const hideTerms = (filters?.hide_terms ?? []).map((t) => t.toLowerCase()).filter((t) => t !== '');
    const boostTerms = (filters?.boost_terms ?? []).map((t) => t.toLowerCase()).filter((t) => t !== '');
    const active = hideTitles.size > 0 || hideTerms.length > 0 || boostTerms.length > 0;
    if (!active) return { shownIdeas: ideas, hiddenCount: 0, filterActive: false };
    const hay = (i: RunIdea) => `${i.title}\n${i.body}`.toLowerCase();
    const visible = ideas.filter(
      (i) =>
        !hideTitles.has(i.title) &&
        !hideTitles.has(displayTitle(i.title)) &&
        !hideTerms.some((t) => hay(i).includes(t)),
    );
    const boosted = visible.filter((i) => boostTerms.some((t) => hay(i).includes(t)));
    const rest = visible.filter((i) => !boostTerms.some((t) => hay(i).includes(t)));
    return { shownIdeas: [...boosted, ...rest], hiddenCount: ideas.length - visible.length, filterActive: true };
  }, [detail, filters]);

  // 'score' sorts a COPY — shownIdeas may BE detail.ideas (unfiltered case), so an
  // in-place sort would mutate state. unmatched titles sink (-1 under a 0+ scale);
  // ties break by idx ascending so the written order is the tiebreak, stable or not.
  // boost float belongs to 'written' order; 'score' is an explicit override — switching back restores it
  const orderedIdeas = useMemo(() => {
    const structured = detail?.structured?.ideas;
    if (order !== 'score' || !structured?.length) return shownIdeas;
    const keyed = shownIdeas.map((i) => ({ i, score: structuredFor(structured, i.title)?.score ?? -1 }));
    keyed.sort((a, b) => b.score - a.score || a.i.idx - b.i.idx);
    return keyed.map((k) => k.i);
  }, [order, shownIdeas, detail]);

  // jump from search/decisions: once the right run is loaded, scroll to the card.
  // sits below the filter memo because a hidden target must be reported, not
  // silently no-opped. every exit path consumes the one-shot target.
  useEffect(() => {
    if (!scrollTarget || !detail || detail.stem !== scrollTarget.stem) return;
    // decisions rows carry the ledger's casing — compare lowercased both sides
    const wanted = scrollTarget.title?.toLowerCase();
    const idx = scrollTarget.idx ?? detail.ideas.find((i) => i.title.toLowerCase() === wanted)?.idx;
    if (idx === undefined) {
      // the jump resolved to a run that doesn't hold the idea — say so, quietly
      showNotice('not found in this run');
      onScrollTargetConsumed();
      return;
    }
    if (!shownIdeas.some((i) => i.idx === idx)) {
      // the card exists but the agent filter hides it — no element to scroll to
      showNotice('hidden by the active filter');
      onScrollTargetConsumed();
      return;
    }
    const raf = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-idx="${idx}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // acknowledge the landing — a mist glow on the card, decaying as the eye settles
      setFlashIdx(idx);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashIdx(null), 1600);
      onScrollTargetConsumed();
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollTarget, detail, shownIdeas, showNotice, onScrollTargetConsumed]);

  const clearFilter = async () => {
    if (clearState === 'busy') return;
    setClearState('busy');
    try {
      const { status } = await clearFilters();
      if (status >= 400) throw new Error('clear failed');
      const fresh = await getFilters(); // refetch — upstream stays the source of truth
      setFilters(fresh);
      setClearState('idle');
      onFiltersChanged?.(); // ToolsPanel shows the active-plan chip — let it refetch too
    } catch {
      setClearState('failed');
      setTimeout(() => setClearState('idle'), 4000);
    }
  };

  // a deleted stem is never 'new' — refreshSection can silently no-op while the
  // collector is mid-poll, so the snapshot may keep listing it for a while
  const stale =
    selectedStem !== null && selectedStem !== deletedStem && !runs.some((r) => r.stem === selectedStem);

  // once a snapshot arrives without the deleted stem, the guard can drop
  useEffect(() => {
    if (deletedStem && !runs.some((r) => r.stem === deletedStem)) setDeletedStem(null);
  }, [runs, deletedStem]);

  return (
    <Panel
      title="ideas"
      riseIndex={2}
      className="mb-4"
      right={
        runs.length > 0 || stale ? (
          // .group wrapper so the destructive action only surfaces on hover/focus
          <span className="group flex items-center gap-2">
            {selectedStem && (
              <DeleteRunButton
                key={selectedStem}
                stem={selectedStem}
                // fall back to the newest remaining run; null when none is left
                // (the shell adopts the newest from the next snapshot — telling it
                // the deleted stem keeps a stale snapshot from re-adopting it)
                onDeleted={() => {
                  setDeletedStem(selectedStem);
                  onRunDeleted?.(selectedStem);
                  onSelect(runs.find((r) => r.stem !== selectedStem)?.stem ?? null);
                }}
              />
            )}
            <select
              value={selectedStem ?? ''}
              onChange={(e) => onSelect(e.target.value)}
              title="switch runs"
              className="glass glass-hover max-w-96 cursor-pointer px-2 py-1 font-mono text-[11px] text-mist outline-none [color-scheme:dark]"
            >
              {/* a just-saved run can outrun the snapshot — keep it selectable until the refresh lands */}
              {stale && selectedStem && <option value={selectedStem}>{fmtStem(selectedStem)} · new</option>}
              {runs.map((r) => (
                <option key={r.stem} value={r.stem}>
                  {runLabel(r)}
                </option>
              ))}
            </select>
          </span>
        ) : undefined
      }
    >
      {notice && <div className="fade-in mb-2 px-2.5 font-mono text-xs text-mist-faint">{notice}</div>}
      {error ? (
        <div className="px-2.5 py-2 font-mono text-xs text-coral">{error}</div>
      ) : !selectedStem ? (
        <EmptyState>no runs yet — start a research above</EmptyState>
      ) : loading ? (
        <EmptyState>
          <span className="animate-pulse">loading run…</span>
        </EmptyState>
      ) : detail && detail.ideas.length === 0 ? (
        <div>
          <EmptyState>run came back empty — add your own below</EmptyState>
          <AddIdeaRow key={detail.stem} stem={detail.stem} onAdded={adoptRun} />
        </div>
      ) : detail ? (
        <div ref={listRef} className="space-y-3">
          {filterActive && (
            <div className="flex min-w-0 items-center gap-2 px-2.5 font-mono text-[11px] text-mist-faint">
              <span className="min-w-0 truncate" title={filters?.interpretation || 'filter active'}>
                {filters?.interpretation || 'filter active'}
              </span>
              <span className="shrink-0 tabular-nums">· {hiddenCount} hidden ·</span>
              <button
                type="button"
                title="drop the filter — show every idea again"
                disabled={clearState === 'busy'}
                onClick={() => void clearFilter()}
                className={`shrink-0 cursor-pointer transition-colors disabled:cursor-default ${
                  clearState === 'failed' ? 'text-coral' : 'text-mist-faint hover:text-mist'
                }`}
              >
                {clearState === 'busy' ? '…' : clearState === 'failed' ? 'failed' : 'clear'}
              </button>
            </div>
          )}
          {/* order toggle — only runs with a structured sidecar can sort by score */}
          {(detail.structured?.ideas?.length ?? 0) > 0 && (
            <div className="flex items-center gap-1 px-2.5">
              <span className="font-mono text-[11px] text-mist-faint">order</span>
              {(['written', 'score'] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  title={o === 'score' ? 'highest score first' : 'as the model wrote them'}
                  onClick={() => setOrder(o)}
                  className={`press cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] ${
                    order === o ? 'glass-raised text-mist' : 'text-mist-faint hover:text-mist'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          {/* preamble/footer carry the model's ranking commentary — quiet bookends,
              set off by a hairline so they read as asides, never cards */}
          {detail.preamble.trim() !== '' && (
            <div className="border-l pl-3 hairline">
              <Markdown
                content={detail.preamble}
                className="text-sm text-mist-faint [&_p]:text-mist-faint [&_li]:text-mist-faint"
              />
            </div>
          )}
          {orderedIdeas.map((i) => (
            // key includes the title: add/delete renumber idx upstream, and an
            // idx-only key would hand one idea's local state to its neighbor
            <IdeaCard
              key={`${detail.stem}-${i.idx}-${i.title}`}
              idea={i}
              stem={detail.stem}
              meta={structuredFor(detail.structured?.ideas, i.title)}
              onRated={onRated}
              onScoped={onScoped}
              onRunUpdated={adoptRun}
              flash={flashIdx === i.idx}
            />
          ))}
          <AddIdeaRow key={detail.stem} stem={detail.stem} onAdded={adoptRun} />
          {detail.footer.trim() !== '' && (
            <div className="border-l pl-3 hairline">
              <Markdown
                content={detail.footer}
                className="text-sm text-mist-faint [&_p]:text-mist-faint [&_li]:text-mist-faint"
              />
            </div>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
