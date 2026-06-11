import { useEffect, useRef, type ReactNode } from 'react';
import { useScrollLock } from '../../hooks';

// ---------- right slide-over for long-form results (ask / roadmap / how-to /
// validate / contrib). App's central esc handler only knows its three overlays —
// a lone itch sheet must close itself, so it owns a window keydown listener. ----------

// module-level refcount — sheets are panel-local overlays the shell does not track;
// App's central key handler asks isSheetOpen() and stands down while one is up.
let openSheets = 0;

/** true while any Sheet is mounted. */
export function isSheetOpen(): boolean {
  return openSheets > 0;
}

export function Sheet({
  kicker,
  title,
  onClose,
  children,
}: {
  /** chrome word ('roadmap', 'ask') — uppercase-tracked mono */
  kicker: string;
  /** data — rendered as-authored, never uppercased */
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useScrollLock();

  useEffect(() => {
    openSheets += 1;
    return () => {
      openSheets -= 1;
    };
  }, []);

  // capture phase so this runs ahead of App's bubble-phase handler; esc closes
  // ONLY this sheet — stopPropagation keeps it from also closing a shell overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // move focus into the sheet on open so esc/tab work without a click (MutesDrawer
  // idiom) — but never steal it from a text field: a oneshot can resolve minutes
  // later while the user is typing in a blur-saving textarea elsewhere
  useEffect(() => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* backdrop — click closes; the aside is a sibling, so panel clicks never reach this */}
      <div className="backdrop-fade absolute inset-0 bg-ink/60" onClick={onClose} />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title ? `${kicker} — ${title}` : kicker}
        className="glass-raised slide-in-right relative h-full w-full max-w-xl overflow-y-auto overscroll-contain p-5 outline-none"
      >
        <header className="mb-4 flex min-w-0 items-baseline justify-between gap-3 border-b pb-3 hairline">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">
              {kicker}
            </span>
            {title && (
              <span className="min-w-0 truncate text-sm font-semibold text-mist" title={title}>
                {title}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="close (esc)"
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
          >
            close
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}
