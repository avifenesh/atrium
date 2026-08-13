import { useState, type CSSProperties, type ReactNode } from 'react';
import { addMute, dispatchToEigen, isMuted, removeMute } from '../api';
import { useNow } from '../hooks';
import type { EigenDispatch, MuteKind, Snapshot } from '../../../shared/types';

/** Glass panel — top-level building block of every view.
 *  v2: quiet mono title (serif is reserved for wordmark + hero numerals), optional
 *  quiet-counter chip in the header right (quietCount / onQuietClick). */
export function Panel({
  title,
  children,
  riseIndex = 0,
  rise = true,
  className = '',
  right,
  quietCount,
  onQuietClick,
}: {
  title?: string;
  children: ReactNode;
  riseIndex?: number;
  /** false skips the page-load rise stagger — for panels that remount mid-session */
  rise?: boolean;
  className?: string;
  right?: ReactNode;
  quietCount?: number;
  onQuietClick?: () => void;
}) {
  const showChip = quietCount !== undefined && quietCount > 0;
  return (
    <section
      className={`panel-surface min-w-0 ${rise ? 'rise ' : ''}p-4 xl:p-5 ${className}`}
      style={rise ? ({ '--rise-i': riseIndex } as CSSProperties) : undefined}
    >
      {(title || right || showChip) && (
        <header className="mb-3 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
          {title && (
            <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-mist">{title}</h2>
          )}
          {(right || showChip) && (
            <div className="panel-actions ml-auto flex min-w-0 max-w-full flex-wrap items-baseline justify-end gap-x-3 gap-y-2 text-xs text-mist-dim">
              {right}
              {showChip && <QuietChip count={quietCount} onClick={onQuietClick} />}
            </div>
          )}
        </header>
      )}
      {children}
    </section>
  );
}

/** "<n> quieted" counter chip — the doorway to the archive (mutes drawer). */
export function QuietChip({ count, onClick }: { count: number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open the quiet archive"
      className="quiet-chip shrink-0 cursor-pointer whitespace-nowrap px-2 py-1 font-mono text-[10px] text-mist-faint transition-colors hover:text-amber"
    >
      {count} quiet
    </button>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-mist-faint first:mt-0">
      {children}
    </div>
  );
}

export function Dot({ status }: { status: string }) {
  return <span className={`dot dot-${status}`} />;
}

export function RelTime({ iso }: { iso: string | null }) {
  const now = useNow(30000); // before the early return — hooks must run unconditionally
  if (!iso) return <span className="shrink-0 font-mono text-xs text-mist-faint">—</span>;
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const rel = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-mist-faint" title={new Date(iso).toLocaleString()}>
      {rel}
    </span>
  );
}

/** The standard interactive row — whole row clickable (DESIGN v2: everything that
 *  names a thing is clickable). href opens in a new tab; onClick fires in place.
 *  Rendered as a div (role=link|button, Enter/Space) rather than <a>/<button>:
 *  rows contain their own interactive hover clusters (MuteButton, CopyText, …) and
 *  interactive content inside <a>/<button> is invalid HTML. With neither href nor
 *  onClick the row is inert — keep the hover bg (cluster reveal) but no pointer. */
export function Row({
  onClick,
  href,
  children,
  className = '',
  title,
  id,
}: {
  onClick?: () => void;
  href?: string;
  children: ReactNode;
  className?: string;
  title?: string;
  id?: string;
}) {
  const base = `surface-row group row-glide flex w-full min-w-0 items-center gap-2 px-2.5 py-2.5 text-left transition-colors ${className}`;
  if (!href && !onClick) {
    return (
      <div id={id} className={base} title={title}>
        {children}
      </div>
    );
  }
  const activate = href ? () => window.open(href, '_blank', 'noopener,noreferrer') : onClick!;
  return (
    <div
      id={id}
      role={href ? 'link' : 'button'}
      tabIndex={0}
      title={title}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // inner controls handle their own keys
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      className={`${base} cursor-pointer`}
    >
      {children}
    </div>
  );
}

/** Click-to-copy with transient in-place feedback. */
export function CopyText({ text, children, className = '' }: { text: string; children: ReactNode; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      title={`copy ${text}`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 1500);
      }}
      className={`min-w-0 max-w-full overflow-hidden cursor-pointer text-left transition-colors hover:text-mist ${className}`}
    >
      {state === 'idle' ? (
        children
      ) : (
        <span className={`font-mono text-[11px] ${state === 'copied' ? 'text-jade' : 'text-coral'}`}>{state}</span>
      )}
    </button>
  );
}

/** Open a task in grok from a row's hover cluster. While a dispatch for this
 *  sourceId is running, renders a jade "grok" status chip instead of the button. */
export function SendToEigen({
  title,
  url,
  repo,
  sourceId,
  dispatches,
}: {
  title: string;
  url?: string;
  repo?: string;
  sourceId?: string;
  dispatches: EigenDispatch[];
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');
  const [sentId, setSentId] = useState<string | null>(null);
  const running =
    sourceId !== undefined && dispatches.some((d) => d.status === 'running' && d.sourceId === sourceId);
  const runningId = sourceId
    ? dispatches.find((d) => d.status === 'running' && d.sourceId === sourceId)?.id
    : undefined;
  const logId = runningId ?? sentId;
  if (running || logId) {
    return (
      <button
        type="button"
        title="open grok dispatch log"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (logId) location.hash = `agents/dispatch-${logId}`;
        }}
        className="shrink-0 cursor-pointer whitespace-nowrap rounded-full bg-jade/10 px-2 py-0.5 font-mono text-[10px] text-jade"
      >
        {running ? 'grok' : 'log'}
      </button>
    );
  }
  return (
    <button
      type="button"
      title="open this in grok"
      disabled={state === 'busy'}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state === 'busy') return;
        setState('busy');
        try {
          const res = await dispatchToEigen({ title, url, repo, sourceId });
          if ('error' in res) throw new Error(res.error);
          if ('id' in res && typeof res.id === 'string') setSentId(res.id);
          setState('sent');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState((s) => (s === 'busy' ? s : 'idle')), 4000);
      }}
      className={`${state === 'idle' ? 'hover-cluster' : ''} shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        state === 'sent' ? 'text-jade' : state === 'failed' ? 'text-coral' : 'text-mist-faint hover:text-amber'
      }`}
    >
      {state === 'busy' ? '…' : state === 'sent' ? 'sent' : state === 'failed' ? 'failed' : 'open in grok'}
    </button>
  );
}

/** Hover-revealed quiet button (also keyboard-reachable: the .hover-cluster utility
 *  reveals on .group:focus-within alongside .group:hover, and reserves space so
 *  nothing shifts). Enforce mode really pauses the source, so it takes two clicks:
 *  arm ("sure?"), then fire. */
export function MuteButton({
  kind,
  target,
  enforce = false,
  className = '',
  label = 'quiet',
  untilActivity = false,
}: {
  kind: MuteKind;
  target: string;
  enforce?: boolean;
  className?: string;
  label?: string;
  /** github-item only: quiet auto-lifts when the item moves (new comment/push) */
  untilActivity?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      title={
        enforce
          ? `quiet ${target} (pauses the source)`
          : untilActivity
            ? `quiet ${target} — comes back on new activity`
            : `quiet ${target}`
      }
      disabled={busy}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (enforce && !armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 4000);
          return;
        }
        setArmed(false);
        setBusy(true);
        try {
          await addMute({ kind, target, enforce, ...(untilActivity ? { untilActivity: true } : {}) });
          setFailed(false);
        } catch {
          setFailed(true);
          setTimeout(() => setFailed(false), 4000);
        } finally {
          setBusy(false);
        }
      }}
      className={`${armed || failed || busy ? '' : 'hover-cluster'} shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        armed || failed ? 'text-coral hover:text-coral' : 'text-mist-faint hover:text-amber'
      } ${className}`}
    >
      {busy ? '…' : failed ? 'failed' : armed ? 'sure?' : label}
    </button>
  );
}

export function UnmuteButton({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await removeMute(id);
          setFailed(false);
        } catch {
          setFailed(true);
          setTimeout(() => setFailed(false), 4000);
        }
      }}
      className={`shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        failed ? 'text-coral' : 'text-amber hover:text-mist'
      }`}
    >
      {failed ? 'failed' : 'unquiet'}
    </button>
  );
}

/** Quiet = archive (DESIGN v2): muted children unmount entirely. The quiet drawer
 *  is where they live on. Count hidden items yourself for the Panel quietCount chip. */
export function Mutable({
  snapshot,
  kind,
  target,
  children,
}: {
  snapshot: Snapshot;
  kind: MuteKind;
  target: string;
  children: ReactNode;
}) {
  if (isMuted(snapshot, kind, target)) return null;
  return <>{children}</>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state px-2.5 py-5 text-sm text-mist-faint">{children}</div>;
}
