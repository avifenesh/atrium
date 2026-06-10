import { useState } from 'react';
import type { Snapshot, ScheduleEntry } from '../../../shared/types';
import { Panel, Dot, RelTime, MuteButton, Mutable, EmptyState } from '../components/ui';

function shortSource(s: ScheduleEntry['source']): string {
  return s === 'systemd-user' || s === 'systemd-system' ? 'systemd' : s;
}

/** RelTime renders past deltas only; nextRun needs forward "in Xm". */
function NextRun({ iso }: { iso: string | null }) {
  if (!iso) return <span className="font-mono text-xs text-mist-faint">—</span>;
  const d = new Date(iso).getTime() - Date.now();
  if (d <= 0) return <RelTime iso={iso} />;
  const s = Math.floor(d / 1000);
  const rel =
    s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return (
    <span className="font-mono text-xs text-mist" title={new Date(iso).toLocaleString()}>
      in {rel}
    </span>
  );
}

const COLS = 'flex items-center gap-3';

export default function SchedulePanel({ snapshot }: { snapshot: Snapshot }) {
  const { entries, error, updatedAt } = snapshot.schedule;
  const [filter, setFilter] = useState<string>('all');

  const sources = [...new Set(entries.map((e) => shortSource(e.source)))];

  const upcoming = entries
    .filter((e) => e.enabled && e.nextRun)
    .sort((a, b) => (a.nextRun as string).localeCompare(b.nextRun as string));
  const rest = entries
    .filter((e) => !(e.enabled && e.nextRun))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  const sorted = [...upcoming, ...rest].filter((e) => filter === 'all' || shortSource(e.source) === filter);

  return (
    <Panel title="schedule" riseIndex={0} right={<RelTime iso={updatedAt} />}>
      {error && (
        <div className="mb-3 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</div>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {['all', ...sources].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] transition-colors ${
              filter === s ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <EmptyState>nothing scheduled</EmptyState>
      ) : (
        <div>
          <div className={`${COLS} border-b py-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-faint hairline`}>
            <span className="w-16 shrink-0">src</span>
            <span className="min-w-0 flex-1">name</span>
            <span className="w-36 shrink-0">expr</span>
            <span className="w-20 shrink-0 text-right">next</span>
            <span className="w-14 shrink-0 text-right">last</span>
            <span className="w-2 shrink-0" />
            <span className="w-12 shrink-0" />
          </div>
          <div className="max-h-[34rem] overflow-y-auto">
            {sorted.map((e) => (
              <Mutable key={e.id} snapshot={snapshot} kind="schedule" target={e.id}>
                <div className={`group ${COLS} border-b py-2 last:border-b-0 hairline`}>
                  <span className="w-16 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-center font-mono text-[10px] text-mist-dim">
                    {shortSource(e.source)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm ${e.enabled ? 'text-mist' : 'text-mist-faint'}`}>{e.name}</div>
                    {e.lastStatus === 'fail' && e.detail && (
                      <div className="truncate text-xs text-coral" title={e.detail}>
                        {e.detail}
                      </div>
                    )}
                  </div>
                  <span className="w-36 shrink-0 truncate font-mono text-xs text-mist-dim" title={e.expr}>
                    {e.expr}
                  </span>
                  <span className="w-20 shrink-0 text-right">
                    <NextRun iso={e.nextRun} />
                  </span>
                  <span className="w-14 shrink-0 text-right">
                    <RelTime iso={e.lastRun} />
                  </span>
                  <Dot status={e.lastStatus === 'ok' ? 'running' : e.lastStatus === 'fail' ? 'error' : 'off'} />
                  <span className="w-12 shrink-0 text-right">
                    {e.muteable && <MuteButton kind="schedule" target={e.id} enforce />}
                  </span>
                </div>
              </Mutable>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
