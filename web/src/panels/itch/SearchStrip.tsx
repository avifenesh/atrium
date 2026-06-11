import { useEffect, useState, type CSSProperties } from 'react';
import { Row } from '../../components/ui';
import { searchIdeas, type SearchHit } from './api';
import { RATING_LABEL, displayTitle, fmtStem } from './util';

// ---------- search (rise 1, slim — sits above the feed it jumps into) ----------

export function SearchStrip({ onJump }: { onJump: (stem: string, idx: number) => void }) {
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
      searchIdeas(query, ac.signal)
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
    <section className="glass field-glow rise mb-4 px-4 py-3 xl:px-5" style={{ '--rise-i': 1 } as CSSProperties}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search ideas…"
        className="w-full bg-transparent px-0.5 py-0.5 font-mono text-sm text-mist outline-none placeholder:text-mist-faint"
      />
      {error && <div className="fade-in mt-1 px-1.5 font-mono text-xs text-coral">{error}</div>}
      {q.trim().length >= 2 && !error && (
        <div className="fade-in mt-1">
          {shown.length === 0 ? (
            <div className="px-1.5 py-1 text-xs text-mist-faint">nothing matches — try fewer words</div>
          ) : (
            <>
              {shown.map((h) => (
                <Row
                  key={`${h.stem}-${h.idx}`}
                  onClick={() => onJump(h.stem, h.idx)}
                  title="jump to this idea in its run"
                  className="group"
                >
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-sm text-mist"
                      title={`${displayTitle(h.title)} — ${h.snippet}`}
                    >
                      {displayTitle(h.title)}
                    </span>
                    {h.rating !== null && (
                      <span
                        className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-mist-dim"
                        title={RATING_LABEL[h.rating]}
                      >
                        {h.rating}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[11px] text-mist-faint" title={`from ${h.stem}`}>
                      {fmtStem(h.stem)}
                    </span>
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
