import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { dispatchToEigen, fetchGithubItem, postGithubComment } from '../api';
import { useScrollLock } from '../hooks';
import { Markdown } from './markdown';
import { Dot, RelTime } from './ui';
import type { GithubComment, GithubItemDetail } from '../../../shared/types';

// the visible send-chord glyph matches the actual modifier on this machine
const isMac = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform,
);
const SEND_CHORD = isMac ? '⌘↵' : 'ctrl ↵';

// Right-side slide-over: read an issue/PR and comment without leaving atrium. The
// door out (open on github) is always one click away but never forced. Calm glass,
// mono for ids/meta, amber only for attention.

/** state -> status dot semantics. open is calm (not amber); merged jade; closed faint. */
function stateDot(kind: 'issue' | 'pr', state: string, merged: boolean): string {
  if (merged) return 'running'; // jade
  if (state === 'closed') return kind === 'pr' ? 'error' : 'off'; // closed pr (not merged) is coral, issue faint
  return 'idle'; // open — quiet
}

const DECISION_CLS: Record<string, string> = {
  APPROVED: 'text-jade',
  CHANGES_REQUESTED: 'text-coral',
  REVIEW_REQUIRED: 'text-amber',
};

const REVIEW_CLS: Record<string, string> = {
  APPROVED: 'text-jade',
  CHANGES_REQUESTED: 'text-coral',
  COMMENTED: 'text-mist-dim',
  DISMISSED: 'text-mist-faint',
};

const CI_CLS: Record<string, string> = {
  SUCCESS: 'text-jade',
  FAILURE: 'text-coral',
  ERROR: 'text-coral',
  PENDING: 'text-amber',
  EXPECTED: 'text-amber',
};

function Chip({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded border hairline px-1.5 py-px font-mono text-[10px] ${className}`}
    >
      {children}
    </span>
  );
}

function MetaRow({ pr }: { pr: NonNullable<GithubItemDetail['pr']> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] tabular-nums">
      {pr.merged && <Chip className="text-jade">merged</Chip>}
      {pr.isDraft && <Chip className="text-mist-faint">draft</Chip>}
      {pr.reviewDecision && (
        <Chip className={DECISION_CLS[pr.reviewDecision] ?? 'text-mist-dim'}>
          {pr.reviewDecision.toLowerCase().replace('_', ' ')}
        </Chip>
      )}
      {pr.ci && <Chip className={CI_CLS[pr.ci] ?? 'text-mist-dim'}>ci {pr.ci.toLowerCase()}</Chip>}
      <span className="text-jade">+{pr.additions}</span>
      <span className="text-coral">-{pr.deletions}</span>
      <span className="text-mist-faint">{pr.changedFiles} files</span>
      <span className="ml-1 truncate text-mist-dim" title={`${pr.headRef} → ${pr.baseRef}`}>
        {pr.headRef}
        <span className="text-mist-faint"> → </span>
        {pr.baseRef}
      </span>
    </div>
  );
}

function CommentCard({ c }: { c: GithubComment }) {
  const stateCls = c.reviewState ? (REVIEW_CLS[c.reviewState] ?? 'text-mist-dim') : '';
  return (
    <div className="rounded-lg border hairline bg-white/[0.02] p-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="truncate text-sm text-mist">{c.author || 'unknown'}</span>
        {c.association && c.association !== 'NONE' && (
          <Chip className="text-mist-faint">{c.association.toLowerCase()}</Chip>
        )}
        {c.kind === 'review' && c.reviewState && (
          <Chip className={stateCls}>{c.reviewState.toLowerCase().replace('_', ' ')}</Chip>
        )}
        <span className="ml-auto">
          <RelTime iso={c.createdAt} />
        </span>
      </div>
      {c.body.trim() ? (
        <Markdown content={c.body} />
      ) : (
        <div className="text-sm italic text-mist-faint">no comment text</div>
      )}
    </div>
  );
}

export default function ItemDetail({
  repo,
  number,
  onClose,
  escapeRef,
}: {
  repo: string;
  number: number;
  onClose: () => void;
  /** App's centralized esc handler calls this when the slide-over is the top layer */
  escapeRef: MutableRefObject<(() => void) | null>;
}) {
  const [detail, setDetail] = useState<GithubItemDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // local thread copy so optimistic comments append without a refetch
  const [extra, setExtra] = useState<GithubComment[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<'idle' | 'busy' | 'failed'>('idle');
  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // esc handler reads the draft through a ref so the listener never re-binds per keystroke
  const draftRef = useRef('');
  draftRef.current = draft;

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setDetail(null);
    setErr(null);
    setExtra([]);
    fetchGithubItem(repo, number)
      .then((d) => {
        if (!stale) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!stale) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [repo, number]);

  // esc step, registered with App's centralized handler (no window listener of our own):
  // a composer holding text absorbs the first esc — blur, keep the draft;
  // focus returns to the panel so the next esc closes
  useEffect(() => {
    escapeRef.current = () => {
      const composer = composerRef.current;
      if (composer && document.activeElement === composer && draftRef.current.trim()) {
        panelRef.current?.focus({ preventScroll: true });
        return;
      }
      onClose();
    };
    return () => {
      escapeRef.current = null;
    };
  }, [onClose, escapeRef]);

  // move focus into the slide-over on open (esc/tab work without a click)
  useScrollLock();
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const githubUrl = detail?.url || `https://github.com/${repo}/issues/${number}`;
  const comments = detail ? [...detail.comments, ...extra] : [];

  const send = async () => {
    const text = draft.trim();
    if (!text || sending === 'busy') return;
    setSending('busy');
    try {
      const { comment } = await postGithubComment(repo, number, text);
      setExtra((xs) => [...xs, comment]);
      setDraft('');
      setSending('idle');
    } catch {
      setSending('failed');
      setTimeout(() => setSending((s) => (s === 'failed' ? 'idle' : s)), 4000);
    }
  };

  const handToEigen = async () => {
    if (!detail) return;
    const sourceId = `${repo}#${number}`;
    await dispatchToEigen({ title: detail.title, url: githubUrl, repo, sourceId }).catch(() => undefined);
  };

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={`${repo}#${number}`}>
      {/* backdrop — click closes; the panel is a sibling, so panel clicks never reach this */}
      <div className="backdrop-fade absolute inset-0 bg-ink/50" onClick={onClose} />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="glass-raised slide-in-right absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col outline-none"
      >
        {/* header */}
        <header className="flex items-start gap-3 border-b hairline px-5 py-4">
          <span className="mt-1 shrink-0">
            <Dot status={detail ? stateDot(detail.kind, detail.state, !!detail.pr?.merged) : 'unknown'} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 font-mono text-[11px] text-mist-faint">
              <span className="uppercase tracking-[0.15em]">{detail?.kind ?? 'item'}</span>
              <span className="truncate text-mist-dim">
                {repo}#{number}
              </span>
              {detail && <span className="text-mist-faint">{detail.state}</span>}
            </div>
            <h2 className="mt-0.5 break-words text-sm font-semibold text-mist" title={detail?.title}>
              {detail?.title ?? (loading ? 'loading…' : repo)}
            </h2>
          </div>
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="open on github"
            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-slate-glow"
          >
            github ↗
          </a>
          <button
            type="button"
            onClick={onClose}
            title="close (esc)"
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
          >
            close
          </button>
        </header>

        {/* scroll body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && <div className="animate-pulse py-6 text-sm text-mist-faint">loading…</div>}
          {err && (
            <div className="rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{err}</div>
          )}

          {detail && (
            <>
              {detail.pr && (
                <div className="mb-3">
                  <MetaRow pr={detail.pr} />
                </div>
              )}

              {detail.labels.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {detail.labels.map((l) => (
                    <Chip key={l} className="text-mist-dim">
                      {l}
                    </Chip>
                  ))}
                </div>
              )}

              {/* issue/PR body */}
              <div className="rounded-lg border hairline bg-white/[0.02] p-3">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="truncate text-sm text-mist">{detail.author || 'unknown'}</span>
                  <span className="ml-auto">
                    <RelTime iso={detail.createdAt} />
                  </span>
                </div>
                {detail.body.trim() ? (
                  <Markdown content={detail.body} />
                ) : (
                  <div className="text-sm italic text-mist-faint">no description</div>
                )}
              </div>

              {/* thread */}
              <div className="mt-4 space-y-3">
                {comments.length === 0 ? (
                  <div className="px-1 py-2 text-sm text-mist-faint">no comments yet</div>
                ) : (
                  comments.map((c, i) => <CommentCard key={`${c.id || c.kind}-${i}`} c={c} />)
                )}
              </div>
            </>
          )}
        </div>

        {/* composer — pinned at the bottom */}
        <div className="border-t hairline px-5 py-3">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // cmd/ctrl+enter sends — fast path for the owner's own github
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="comment (markdown)…"
            rows={3}
            disabled={!detail}
            className="w-full resize-y rounded-lg border hairline bg-white/[0.03] px-3 py-2 text-sm text-mist placeholder:text-mist-faint focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber disabled:opacity-50"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={handToEigen}
              disabled={!detail}
              title="hand this whole item to eigen"
              className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-amber disabled:opacity-50"
            >
              → eigen
            </button>
            <span className="ml-auto font-mono text-[11px] text-mist-faint">
              {sending === 'failed' ? (
                <span className="text-coral">send failed</span>
              ) : (
                <span className="kbd" title="cmd/ctrl+enter sends">
                  {SEND_CHORD}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!detail || sending === 'busy' || draft.trim().length === 0}
              className="cursor-pointer rounded-lg border hairline px-3 py-1 text-sm text-mist transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:opacity-40"
            >
              {sending === 'busy' ? 'sending…' : 'send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
