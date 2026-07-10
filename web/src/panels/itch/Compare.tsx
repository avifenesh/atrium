import { useEffect, useState } from 'react';
import { Dot, EmptyState, Panel, SectionLabel } from '../../components/ui';
import { getCompare, getResearchStatus, launchBaseline, type CompareIdeaRef, type ComparePayload } from './api';
import { displayTitle, fmtStem } from './util';

// unique/overlap entries are {idx,title} refs upstream (older payloads may carry bare strings)
function refTitle(x: CompareIdeaRef | string): string {
  return typeof x === 'string' ? x : x.title;
}

// ---------- collide vs baseline (rise 3) — only for collide runs ----------
// 'ready' shows overlap stats; 'missing_baseline' offers to launch the exact
// twin run (shares the single research slot — 409 is a quiet state).

const POLL_MS = 5_000;
const POLL_CAP_MS = 12 * 60_000; // baseline runs are long; past this, stop claiming progress

export function ComparePanel({
  stem,
  isCollide,
  riseIndex,
}: {
  stem: string | null;
  isCollide: boolean;
  riseIndex: number;
}) {
  const [data, setData] = useState<ComparePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [baseline, setBaseline] = useState<string | undefined>(undefined); // candidate override
  const [nonce, setNonce] = useState(0); // bump = refetch compare
  const [launchBusy, setLaunchBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; isError: boolean } | null>(null);
  const [polling, setPolling] = useState(false);

  // switching runs drops the candidate choice, any note, and a stale poll
  useEffect(() => {
    setBaseline(undefined);
    setNote(null);
    setPolling(false);
  }, [stem]);

  useEffect(() => {
    if (!stem || !isCollide) {
      setData(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    getCompare(stem, baseline, ac.signal)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => ac.abort();
  }, [stem, isCollide, baseline, nonce]);

  // after a launch: watch the shared research slot until running flips false,
  // then refetch the compare. capped — past the cap the strip is the live view.
  useEffect(() => {
    if (!polling) return;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let gone = false;
    const deadline = Date.now() + POLL_CAP_MS;
    const tick = async () => {
      try {
        const st = await getResearchStatus(0, ac.signal);
        if (gone) return;
        if (!st.running) {
          setPolling(false);
          setNonce((n) => n + 1);
          return;
        }
      } catch {
        if (gone) return; // blips just retry
      }
      if (Date.now() > deadline) {
        setPolling(false);
        setNote({ text: 'baseline still running — the research strip has the live log', isError: false });
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      gone = true;
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, [polling]);

  const launch = async () => {
    if (!stem || launchBusy) return;
    setLaunchBusy(true);
    setNote(null);
    try {
      const { status, body } = await launchBaseline(stem);
      if (status === 409) setNote({ text: 'research slot busy', isError: false });
      else if (body?.already_exists && body.baseline_stem) setNonce((n) => n + 1);
      else if (body?.ok) setPolling(true);
      else setNote({ text: body?.error ?? `launch failed (${status})`, isError: true });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setLaunchBusy(false);
    }
  };

  if (!stem || !isCollide) return null;
  if (data?.status === 'not_collide') return null; // shouldn't happen behind the gate

  const s = data?.status === 'ready' ? data.summary : undefined;

  return (
    <Panel
      title="Exploration compared with baseline"
      riseIndex={riseIndex}
      rise={false} // panel remounts on every collide pick — replaying the load stagger mid-session is a 210ms hole
      className="mb-4"
      right={
        data?.status === 'ready' && data.baseline ? (
          <span className="font-mono text-xs text-mist-faint">vs {fmtStem(data.baseline.stem)}</span>
        ) : undefined
      }
    >
      {error ? (
        <div className="fade-in px-2.5 py-2 font-mono text-xs text-coral">{error}</div>
      ) : loading || data === null ? (
        <EmptyState>comparing…</EmptyState>
      ) : data.status === 'ready' ? (
        <div className="fade-in px-0.5">
          {s && (
            <div className="mb-1 font-mono text-xs tabular-nums text-mist-dim">
              source {s.source_count} · baseline {s.baseline_count} · overlap {s.overlap_count} (
              {Math.round(s.overlap_ratio * 100)}%)
            </div>
          )}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="min-w-0">
              <SectionLabel>unique to collide</SectionLabel>
              {(data.source_unique ?? []).length === 0 ? (
                <div className="py-0.5 text-xs text-mist-faint">none</div>
              ) : (
                (data.source_unique ?? []).slice(0, 6).map((t) => (
                  <div key={refTitle(t)} className="truncate py-0.5 text-sm text-mist-dim" title={refTitle(t)}>
                    {displayTitle(refTitle(t))}
                  </div>
                ))
              )}
            </div>
            <div className="min-w-0">
              <SectionLabel>unique to baseline</SectionLabel>
              {(data.baseline_unique ?? []).length === 0 ? (
                <div className="py-0.5 text-xs text-mist-faint">none</div>
              ) : (
                (data.baseline_unique ?? []).slice(0, 6).map((t) => (
                  <div key={refTitle(t)} className="truncate py-0.5 text-sm text-mist-dim" title={refTitle(t)}>
                    {displayTitle(refTitle(t))}
                  </div>
                ))
              )}
            </div>
          </div>
          {(data.overlap ?? []).length > 0 && (
            <>
              <SectionLabel>overlap</SectionLabel>
              {(data.overlap ?? []).slice(0, 4).map((o, i) => (
                <div
                  key={`${refTitle(o.source)}-${i}`}
                  className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs"
                  title={`${refTitle(o.source)} ↔ ${refTitle(o.baseline)}`}
                >
                  <span className="min-w-0 max-w-[45%] truncate text-mist-dim">{displayTitle(refTitle(o.source))}</span>
                  <span className="shrink-0 text-mist-faint">↔</span>
                  <span className="min-w-0 flex-1 truncate text-mist-dim">{displayTitle(refTitle(o.baseline))}</span>
                  {typeof o.score === 'number' && (
                    <span className="shrink-0 font-mono tabular-nums text-mist-faint">{Math.round(o.score * 100)}%</span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        // missing_baseline
        <div className="fade-in space-y-2 px-0.5">
          <div className="text-sm text-mist-faint">
            no exact baseline twin for this collide run — launch one (same flags, chaos off) to see what the
            collision dial actually changed
          </div>
          {(data.candidates?.length ?? 0) > 0 && (
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-[11px] text-mist-faint">or compare against</span>
              <select
                value={baseline ?? ''}
                onChange={(e) => setBaseline(e.target.value || undefined)}
                className="glass glass-hover max-w-64 cursor-pointer px-2 py-1 font-mono text-[11px] text-mist outline-none [color-scheme:dark]"
              >
                <option value="">pick a run…</option>
                {data.candidates?.map((c) => (
                  <option key={c.stem} value={c.stem}>
                    {fmtStem(c.stem)} · {c.n_ideas} ideas
                  </option>
                ))}
              </select>
            </div>
          )}
          {polling ? (
            <div className="fade-in flex items-center gap-2 font-mono text-xs text-mist-faint">
              <span className="inline-flex shrink-0 breathe">
                <Dot status="running" />
              </span>
              baseline research running…
            </div>
          ) : data.can_launch_baseline ? (
            <button
              type="button"
              disabled={launchBusy}
              onClick={() => void launch()}
              className="cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] text-mist-dim press glass glass-hover hover:text-mist disabled:opacity-50"
            >
              {launchBusy ? '…' : 'launch baseline'}
            </button>
          ) : data.launch_blocked_reason ? (
            <div className="font-mono text-xs text-mist-faint">{data.launch_blocked_reason}</div>
          ) : null}
          {note && (
            <div
              className={`fade-in truncate font-mono text-xs ${note.isError ? 'text-coral' : 'text-mist-faint'}`}
              title={note.text}
            >
              {note.text}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
