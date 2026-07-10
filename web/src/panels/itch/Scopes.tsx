import { useEffect, useState } from 'react';
import { Markdown } from '../../components/markdown';
import { EmptyState, Panel, RelTime, Row } from '../../components/ui';
import { getScope, getScopes, type ScopeInfo } from './api';
import { Sheet } from './Sheet';
import { fmtStem } from './util';

// ---------- scope documents (rise 5) ----------
// upstream serves the listing newest-first — render as served, no client sort

export function ScopesPanel({ riseIndex, version }: { riseIndex: number; version: number }) {
  const [scopes, setScopes] = useState<ScopeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // version bumps when a scope oneshot saves a file; tick is the manual refresh
  const [tick, setTick] = useState(0);

  const [sheet, setSheet] = useState<{ file: string; title: string } | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    getScopes(ac.signal)
      .then((r) => {
        setScopes(r.scopes);
        setError(null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [version, tick]);

  useEffect(() => {
    if (!sheet) return;
    const ac = new AbortController();
    setContent(null);
    setSheetError(null);
    getScope(sheet.file, ac.signal)
      .then((s) => setContent(s.content))
      .catch((e) => {
        if (!ac.signal.aborted) setSheetError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [sheet]);

  return (
    <Panel
      title="Project scopes"
      riseIndex={riseIndex}
      right={
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          title="re-list scope files"
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
        >
          refresh
        </button>
      }
    >
      <div className="max-h-[28rem] overflow-y-auto">
        {error ? (
          <div className="truncate px-2.5 py-2 font-mono text-xs text-coral" title={error}>
            {error}
          </div>
        ) : scopes === null ? (
          <EmptyState>
            <span className="animate-pulse">loading…</span>
          </EmptyState>
        ) : scopes.length === 0 ? (
          <EmptyState>no scopes yet — rate an idea 5, then scope it</EmptyState>
        ) : (
          scopes.map((s) => (
            <Row key={s.file} onClick={() => setSheet({ file: s.file, title: s.title })} title="read this scope">
              <div className="flex w-full min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-mist" title={s.title}>
                  {s.title}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-mist-faint" title={s.file}>
                  {fmtStem(s.stem)}
                </span>
                <RelTime iso={s.mtime} />
              </div>
            </Row>
          ))
        )}
      </div>

      {sheet && (
        <Sheet kicker="scope" title={sheet.title} onClose={() => setSheet(null)}>
          {sheetError ? (
            <div className="truncate font-mono text-xs text-coral" title={sheetError}>
              {sheetError}
            </div>
          ) : content === null ? (
            <div className="animate-pulse font-mono text-xs text-mist-faint">loading…</div>
          ) : (
            <Markdown content={content} className="text-sm [&_p]:text-mist-dim [&_li]:text-mist-dim" />
          )}
        </Sheet>
      )}
    </Panel>
  );
}
