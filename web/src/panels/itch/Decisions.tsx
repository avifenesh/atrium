import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Panel, Row, SectionLabel } from '../../components/ui';
import { getDecisions, searchIdeas, type Decision } from './api';
import { RATING_LABEL, displayTitle, fmtStem } from './util';
import type { ItchRunInfo } from '../../../../shared/types';

// ---------- decisions ledger (rise 3) ----------

export function DecisionsPanel({
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
    getDecisions(ac.signal)
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
      const hits = await searchIdeas(d.title);
      const hit = hits.find((h) => h.title.toLowerCase() === d.title.toLowerCase());
      if (hit) {
        // pass the RUN's casing, not the ledger's — the feed resolves the card by title
        onJump(hit.stem, hit.title);
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
      riseIndex={4}
      right={
        ratedCount !== null ? (
          <span className="font-mono text-xs tabular-nums text-mist-faint">{ratedCount}</span>
        ) : undefined
      }
    >
      {notice && <div className="fade-in mb-1 px-2.5 font-mono text-xs text-mist-faint">{notice}</div>}
      <div className="max-h-[28rem] overflow-y-auto">
        {error ? (
          <div className="px-2.5 py-2 font-mono text-xs text-coral">{error}</div>
        ) : decisions === null ? (
          <EmptyState>
            <span className="animate-pulse">loading…</span>
          </EmptyState>
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
                  <Row
                    key={`${d.as_of}-${d.title}`}
                    onClick={() => void jump(d)}
                    title="jump to this idea in its run"
                    className="group"
                  >
                    <div className="flex w-full min-w-0 items-center gap-2">
                      <span className="min-w-0 shrink truncate text-sm text-mist" title={displayTitle(d.title)}>
                        {displayTitle(d.title)}
                      </span>
                      {d.note && (
                        <span className="min-w-0 flex-1 truncate text-xs text-mist-faint" title={d.note}>
                          {d.note}
                        </span>
                      )}
                      <span
                        className="ml-auto shrink-0 font-mono text-[11px] text-mist-faint"
                        title={`as of ${d.as_of}`}
                      >
                        {fmtStem(d.as_of)}
                      </span>
                      {/* hover-revealed jump affordance — slate-glow, the link tone */}
                      <span className="hover-cluster shrink-0 font-mono text-[11px] text-slate-glow">→</span>
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
