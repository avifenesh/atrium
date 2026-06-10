import { isMuted } from '../api';
import { MuteButton, RelTime, UnmuteButton } from './ui';
import type { Flag, Snapshot } from '../../../shared/types';

const SEV_RANK: Record<Flag['severity'], number> = { crit: 0, warn: 1, info: 2 };

// border-l on the row, not .glass on the row: unlayered .glass border shorthand
// would beat layered tailwind border utilities.
const SEV_BORDER: Record<Flag['severity'], string> = {
  crit: 'border-l-coral',
  warn: 'border-l-amber',
  info: 'border-l-slate-glow',
};

/** Anomaly strip above the active view. Muted flags dim and sink to the end (DESIGN rule 5). */
export default function FlagStrip({ snapshot }: { snapshot: Snapshot }) {
  const flags = snapshot.flags
    .map((f) => ({ f, muted: isMuted(snapshot, 'flag', f.id) }))
    .sort(
      (a, b) =>
        Number(a.muted) - Number(b.muted) ||
        SEV_RANK[a.f.severity] - SEV_RANK[b.f.severity] ||
        new Date(b.f.raisedAt).getTime() - new Date(a.f.raisedAt).getTime(),
    );

  if (flags.length === 0) return null;

  const now = Date.now();
  const muteIdFor = (flagId: string) =>
    snapshot.mutes.find(
      (m) => m.kind === 'flag' && m.target === flagId && (!m.until || new Date(m.until).getTime() > now),
    )?.id;

  return (
    <div className="glass rise mb-5 px-2 py-1.5">
      <div className="max-h-[8.25rem] space-y-1 overflow-y-auto">
        {flags.map(({ f, muted }) => {
          const muteId = muted ? muteIdFor(f.id) : undefined;
          return (
            <div
              key={f.id}
              className={`group flex items-center gap-3 border-l-2 py-1 pl-3 pr-1 ${SEV_BORDER[f.severity]} ${
                muted ? 'muted-dim' : ''
              }`}
            >
              <span className="shrink-0 text-sm text-mist">{f.title}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-mist-dim">{f.detail}</span>
              <RelTime iso={f.raisedAt} />
              {muteId ? <UnmuteButton id={muteId} /> : <MuteButton kind="flag" target={f.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
