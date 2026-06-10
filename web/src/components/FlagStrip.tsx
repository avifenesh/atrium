import { isMuted } from '../api';
import { MuteButton, QuietChip, RelTime } from './ui';
import type { Flag, Snapshot } from '../../../shared/types';

const SEV_RANK: Record<Flag['severity'], number> = { crit: 0, warn: 1, info: 2 };

// border-l on the row, not .glass on the row: unlayered .glass border shorthand
// would beat layered tailwind border utilities.
const SEV_BORDER: Record<Flag['severity'], string> = {
  crit: 'border-l-coral',
  warn: 'border-l-amber',
  info: 'border-l-slate-glow',
};

/** Flag ids are "<source>:<key>" — map the prefix (falling back to Flag.source)
 *  to the view where the underlying thing lives. */
const VIEW_FOR: Record<string, string> = {
  github: 'tasks',
  agents: 'agents',
  system: 'system',
  schedule: 'schedule',
  subs: 'subs',
  comms: 'comms',
  notes: 'notes',
  surreal: 'system',
};

function viewFor(f: Flag): string | null {
  const prefix = f.id.includes(':') ? f.id.slice(0, f.id.indexOf(':')) : '';
  return VIEW_FOR[prefix] ?? VIEW_FOR[f.source] ?? null;
}

/** Anomaly strip above the active view. Quiet = archive: muted flags are GONE;
 *  a "<n> quieted" chip at the strip end opens the drawer where they live. */
export default function FlagStrip({
  snapshot,
  onNavigate,
  onOpenQuiet,
}: {
  snapshot: Snapshot;
  onNavigate: (viewId: string) => void;
  onOpenQuiet?: () => void;
}) {
  const flags = snapshot.flags
    .filter((f) => !isMuted(snapshot, 'flag', f.id))
    .sort(
      (a, b) =>
        SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
        new Date(b.raisedAt).getTime() - new Date(a.raisedAt).getTime(),
    );
  const hidden = snapshot.flags.length - flags.length;

  if (flags.length === 0 && hidden === 0) return null;

  return (
    <div className="glass rise mb-5 px-2 py-1.5">
      <div className="max-h-[8.25rem] space-y-0.5 overflow-y-auto">
        {flags.map((f) => {
          const view = viewFor(f);
          // whole row navigates (DESIGN v2: whole row clickable, not just the title);
          // "view" + quiet stay in the hover cluster as secondary affordances
          return (
            <div
              key={f.id}
              role={view ? 'button' : undefined}
              tabIndex={view ? 0 : undefined}
              onClick={view ? () => onNavigate(view) : undefined}
              onKeyDown={
                view
                  ? (e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onNavigate(view);
                      }
                    }
                  : undefined
              }
              className={`group flex items-center gap-3 rounded-r-lg border-l-2 py-1 pl-3 pr-1 transition-colors hover:bg-white/[0.04] ${view ? 'cursor-pointer' : ''} ${SEV_BORDER[f.severity]}`}
            >
              <span className="shrink-0 text-sm text-mist">{f.title}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-mist-dim" title={f.detail}>
                {f.detail}
              </span>
              <RelTime iso={f.raisedAt} />
              <span className="flex shrink-0 items-center gap-1">
                {view && (
                  <button
                    type="button"
                    title={`open ${view}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onNavigate(view);
                    }}
                    className="hover-cluster shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] text-slate-glow transition-colors hover:text-mist"
                  >
                    view
                  </button>
                )}
                <MuteButton kind="flag" target={f.id} />
              </span>
            </div>
          );
        })}
        {hidden > 0 && (
          <div className="flex justify-end px-1 py-0.5">
            <QuietChip count={hidden} onClick={onOpenQuiet} />
          </div>
        )}
      </div>
    </div>
  );
}
