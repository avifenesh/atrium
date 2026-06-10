import { useState, type CSSProperties, type ReactNode } from 'react';
import { addMute, dispatchToEigen, isMuted, removeMute } from '../api';
import type { EigenDispatch, MuteKind, Snapshot } from '../../../shared/types';

/** Glass panel — top-level building block of every view.
 *  v2: quiet mono title (serif is reserved for wordmark + hero numerals), optional
 *  quiet-counter chip in the header right (quietCount / onQuietClick). */
export function Panel({
  title,
  children,
  riseIndex = 0,
  className = '',
  right,
  quietCount,
  onQuietClick,
}: {
  title?: string;
  children: ReactNode;
  riseIndex?: number;
  className?: string;
  right?: ReactNode;
  quietCount?: number;
  onQuietClick?: () => void;
}) {
  const showChip = quietCount !== undefined && quietCount > 0;
  return (
    <section className={`glass rise p-4 xl:p-5 ${className}`} style={{ '--rise-i': riseIndex } as CSSProperties}>
      {(title || right || showChip) && (
        <header className="mb-3 flex min-w-0 items-baseline justify-between gap-3">
          {title && (
            <h2 className="truncate font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">{title}</h2>
          )}
          {(right || showChip) && (
            <div className="ml-auto flex shrink-0 items-baseline gap-3 text-xs text-mist-dim">
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
      title="quieted items — open the quiet drawer to unquiet"
      className="shrink-0 cursor-pointer whitespace-nowrap rounded-full border hairline bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-amber"
    >
      {count} quieted
    </button>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint first:mt-0">
      {children}
    </div>
  );
}

export function Dot({ status }: { status: string }) {
  return <span className={`dot dot-${status}`} />;
}

export function RelTime({ iso }: { iso: string | null }) {
  if (!iso) return <span className="shrink-0 font-mono text-xs text-mist-faint">—</span>;
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
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
}: {
  onClick?: () => void;
  href?: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const base = `group flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04] ${className}`;
  if (!href && !onClick) {
    return (
      <div className={base} title={title}>
        {children}
      </div>
    );
  }
  const activate = href ? () => window.open(href, '_blank', 'noopener,noreferrer') : onClick!;
  return (
    <div
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
      className={`min-w-0 cursor-pointer text-left transition-colors hover:text-mist ${className}`}
    >
      {state === 'idle' ? (
        children
      ) : (
        <span className={`font-mono text-[11px] ${state === 'copied' ? 'text-jade' : 'text-coral'}`}>{state}</span>
      )}
    </button>
  );
}

/** Hand a task to eigen from a row's hover cluster. While a dispatch for this
 *  sourceId is running, renders a jade "eigen" status chip instead of the button. */
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
  const running =
    sourceId !== undefined && dispatches.some((d) => d.status === 'running' && d.sourceId === sourceId);
  if (running) {
    return (
      <span
        className="shrink-0 whitespace-nowrap rounded-full bg-jade/10 px-2 py-0.5 font-mono text-[10px] text-jade"
        title="eigen is working on this"
      >
        eigen
      </span>
    );
  }
  return (
    <button
      type="button"
      title="hand this task to eigen"
      disabled={state === 'busy'}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state === 'busy') return;
        setState('busy');
        try {
          const res = await dispatchToEigen({ title, url, repo, sourceId });
          if ('error' in res) throw new Error(res.error);
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
      {state === 'busy' ? '…' : state === 'sent' ? 'sent' : state === 'failed' ? 'failed' : '→ eigen'}
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
}: {
  kind: MuteKind;
  target: string;
  enforce?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      title={enforce ? `quiet ${target} (pauses the source)` : `quiet ${target}`}
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
          await addMute({ kind, target, enforce });
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
      {busy ? '…' : failed ? 'failed' : armed ? 'sure?' : 'quiet'}
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
  return <div className="px-2.5 py-3 text-sm text-mist-faint">{children}</div>;
}
