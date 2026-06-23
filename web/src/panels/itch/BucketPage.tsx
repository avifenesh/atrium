import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Panel } from '../../components/ui';
import { getIdeaBucket, type BucketIdea, type IdeaBucketKey, type RunDetail } from './api';
import { IdeaCard } from './IdeaCard';
import { bucketLabel } from './util';

// ---------- bucket page — one rank (5..1) or the undecided pile, full scroll ----------
// a dedicated full-width view that replaces the section stack: every idea in the
// bucket as a full IdeaCard (body, note, score chips, rate/outcome/ask/roadmap),
// deduped newest-run-first upstream. rating an idea here re-rates it in place
// (optimistic, like the feed) — the bucket membership only re-sorts on reopen, so
// the page never yanks a card out from under the scroll mid-review.

export function BucketPage({
  bucket,
  onBack,
  onRated,
  onScoped,
}: {
  bucket: IdeaBucketKey;
  onBack: () => void;
  /** a rating/note/outcome changed — the shell refetches decisions counts */
  onRated: () => void;
  /** a scope oneshot persisted a file — the shell bumps ScopesPanel's version */
  onScoped: () => void;
}) {
  const [entries, setEntries] = useState<BucketIdea[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setEntries(null);
    setError(null);
    getIdeaBucket(bucket, ac.signal)
      .then((b) => setEntries(b.entries))
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [bucket]);

  // delete-idea returns the renumbered run — drop any local entry from that run whose
  // title no longer appears in it (add-idea never happens here, so this only prunes)
  const onRunUpdated = useCallback((detail: RunDetail) => {
    const live = new Set(detail.ideas.map((i) => i.title.toLowerCase()));
    setEntries((cur) =>
      cur ? cur.filter((e) => e.stem !== detail.stem || live.has(e.title.toLowerCase())) : cur,
    );
  }, []);

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 cursor-pointer font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
      >
        ← decisions
      </button>
      <Panel
        title={bucketLabel(bucket)}
        right={
          entries !== null ? (
            <span className="font-mono text-xs tabular-nums text-mist-faint">{entries.length}</span>
          ) : undefined
        }
      >
        {error ? (
          <div className="px-2.5 py-2 font-mono text-xs text-coral">{error}</div>
        ) : entries === null ? (
          <EmptyState>
            <span className="animate-pulse">loading…</span>
          </EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState>
            {bucket === 'undecided' ? 'nothing left undecided — every idea is rated' : 'no ideas at this rank'}
          </EmptyState>
        ) : (
          <div className="max-h-[calc(100vh-12rem)] space-y-3 overflow-y-auto">
            {entries.map((e) => (
              <IdeaCard
                key={`${e.stem}-${e.idx}-${e.title}`}
                idea={e}
                stem={e.stem}
                meta={e.structured ?? undefined}
                onRated={onRated}
                onScoped={onScoped}
                onRunUpdated={onRunUpdated}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
