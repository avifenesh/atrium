import { useState } from 'react';
import type { Snapshot, ScheduleEntry } from '../../../shared/types';
import { agentAction, isMuted } from '../api';
import { Panel, Dot, RelTime, MuteButton, EmptyState, Row, CopyText } from '../components/ui';

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
    <span className="font-mono text-xs tabular-nums text-mist" title={new Date(iso).toLocaleString()}>
      in {rel}
    </span>
  );
}

/** Hover action on hermes rows — fires the job now, with in-place feedback. */
function RunNow({ jobId }: { jobId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle');
  return (
    <button
      title="run this job now"
      disabled={state === 'busy'}
      onClick={async (e) => {
        e.stopPropagation();
        setState('busy');
        try {
          const res = await agentAction('hermes', 'cron-run', jobId);
          setState(res.ok ? 'ok' : 'fail');
        } catch {
          setState('fail');
        }
        setTimeout(() => setState((s) => (s === 'busy' ? s : 'idle')), 4000);
      }}
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        state === 'idle' ? 'invisible group-hover:visible group-focus-within:visible' : ''
      } ${
        state === 'fail' ? 'text-coral' : state === 'ok' ? 'text-jade' : 'text-mist-faint hover:text-jade'
      }`}
    >
      {state === 'busy' ? '…' : state === 'ok' ? 'ran' : state === 'fail' ? 'failed' : 'run now'}
    </button>
  );
}

const COLS = 'flex items-center gap-3';

export default function SchedulePanel({
  snapshot,
  onOpenQuiet: openQuiet,
}: {
  snapshot: Snapshot;
  onOpenQuiet: () => void;
}) {
  const { entries, error, updatedAt } = snapshot.schedule;
  const [filter, setFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // quieted entries disappear — the drawer is their archive
  const visible = entries.filter((e) => !isMuted(snapshot, 'schedule', e.id));
  const quietCount = entries.length - visible.length;

  const sources = [...new Set(visible.map((e) => shortSource(e.source)))];

  const upcoming = visible
    .filter((e) => e.enabled && e.nextRun)
    .sort((a, b) => (a.nextRun as string).localeCompare(b.nextRun as string));
  const rest = visible
    .filter((e) => !(e.enabled && e.nextRun))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  const sorted = [...upcoming, ...rest].filter((e) => filter === 'all' || shortSource(e.source) === filter);

  return (
    <Panel
      title="schedule"
      riseIndex={0}
      right={<RelTime iso={updatedAt} />}
      quietCount={quietCount || undefined}
      onQuietClick={openQuiet}
    >
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
            <span className="hidden w-36 shrink-0 lg:block">expr</span>
            <span className="w-20 shrink-0 text-right">next</span>
            <span className="w-14 shrink-0 text-right">last</span>
            <span className="w-2 shrink-0" />
            <span className="w-28 shrink-0" />
          </div>
          <div className="max-h-[34rem] overflow-y-auto">
            {sorted.map((e) => {
              const isHermes = e.source === 'hermes';
              const jobId = isHermes ? e.id.slice('hermes:'.length) : null;
              const expanded = expandedId === e.id;
              return (
                <div key={e.id}>
                  <Row
                    onClick={() => setExpandedId((x) => (x === e.id ? null : e.id))}
                    className="group"
                  >
                    <div className={`${COLS} w-full min-w-0`}>
                      <span className="w-16 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-center font-mono text-[10px] text-mist-dim">
                        {shortSource(e.source)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-sm ${e.enabled ? 'text-mist' : 'text-mist-faint'}`}>
                          {e.name}
                        </div>
                        {e.lastStatus === 'fail' && e.detail && (
                          <div className="truncate text-xs text-coral" title={e.detail}>
                            {e.detail}
                          </div>
                        )}
                      </div>
                      <span className="hidden w-36 shrink-0 truncate font-mono text-xs text-mist-dim lg:block" title={e.expr}>
                        {e.expr}
                      </span>
                      <span className="w-20 shrink-0 text-right">
                        <NextRun iso={e.nextRun} />
                      </span>
                      <span className="w-14 shrink-0 text-right">
                        <RelTime iso={e.lastRun} />
                      </span>
                      <Dot status={e.lastStatus === 'ok' ? 'running' : e.lastStatus === 'fail' ? 'error' : 'off'} />
                      <span className="flex w-28 shrink-0 items-center justify-end gap-1">
                        {jobId && <RunNow jobId={jobId} />}
                        {e.muteable && <MuteButton kind="schedule" target={e.id} enforce />}
                      </span>
                    </div>
                  </Row>
                  {expanded && (
                    <div className="mb-1 ml-19 space-y-1 rounded-lg bg-white/[0.03] px-3 py-2 text-xs">
                      <div className="flex items-baseline gap-2">
                        <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-widest text-mist-faint">id</span>
                        <CopyText text={e.id}>
                          <span className="font-mono text-mist-dim">{e.id}</span>
                        </CopyText>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-widest text-mist-faint">expr</span>
                        <span className="min-w-0 break-all font-mono text-mist-dim">{e.expr}</span>
                      </div>
                      {e.detail && (
                        <div className="flex items-baseline gap-2">
                          <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-widest text-mist-faint">detail</span>
                          <span className={`min-w-0 ${e.lastStatus === 'fail' ? 'text-coral' : 'text-mist-dim'}`}>
                            {e.detail}
                          </span>
                        </div>
                      )}
                      <div className="flex items-baseline gap-2">
                        <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-widest text-mist-faint">last</span>
                        <span className="font-mono text-mist-dim">
                          {e.lastRun ? new Date(e.lastRun).toLocaleString() : '—'}
                          {e.lastStatus ? ` · ${e.lastStatus}` : ''}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}
