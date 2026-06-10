import { useState, type CSSProperties, type ReactNode } from 'react';
import { addMute, removeMute } from '../api';
import type { MuteKind, Snapshot } from '../../../shared/types';

/** Glass panel with display-italic title. Top-level building block of every view. */
export function Panel({
  title,
  children,
  riseIndex = 0,
  className = '',
  right,
}: {
  title?: string;
  children: ReactNode;
  riseIndex?: number;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <section className={`glass rise p-5 ${className}`} style={{ '--rise-i': riseIndex } as CSSProperties}>
      {(title || right) && (
        <header className="mb-4 flex items-baseline justify-between">
          {title && <h2 className="font-display text-xl italic text-mist">{title}</h2>}
          {right && <div className="text-xs text-mist-dim">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-widest text-mist-faint first:mt-0">
      {children}
    </div>
  );
}

export function Dot({ status }: { status: string }) {
  return <span className={`dot dot-${status}`} />;
}

export function RelTime({ iso }: { iso: string | null }) {
  if (!iso) return <span className="font-mono text-xs text-mist-faint">—</span>;
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const rel = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return (
    <span className="font-mono text-xs text-mist-faint" title={new Date(iso).toLocaleString()}>
      {rel}
    </span>
  );
}

/** Hover-revealed quiet button. Parent row needs className="group".
 *  Enforce mode really pauses the source, so it takes two clicks: arm ("sure?"), then fire. */
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
      title={enforce ? `quiet ${target} (pauses the source)` : `quiet ${target}`}
      disabled={busy}
      onClick={async (e) => {
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
      className={`${armed || failed ? '' : 'invisible'} rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors group-hover:visible ${
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
      onClick={async () => {
        try {
          await removeMute(id);
          setFailed(false);
        } catch {
          setFailed(true);
          setTimeout(() => setFailed(false), 4000);
        }
      }}
      className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
        failed ? 'text-coral' : 'text-amber hover:text-mist'
      }`}
    >
      {failed ? 'failed' : 'unquiet'}
    </button>
  );
}

/** Wrap a row: dims it when muted. */
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
  const now = Date.now();
  const muted = snapshot.mutes.some((m) => {
    if (m.until && new Date(m.until).getTime() < now) return false;
    if (m.kind === kind && m.target === target) return true;
    if (kind === 'github-repo' && m.kind === 'github-org' && target.startsWith(`${m.target}/`)) return true;
    return false;
  });
  return <div className={muted ? 'muted-dim' : ''}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-3 text-sm text-mist-faint">{children}</div>;
}
