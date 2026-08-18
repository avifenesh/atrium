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
        state === 'idle' ? 'hover-cluster' : ''
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
  const [showDisabled, setShowDisabled] = useState(false);

  // quieted entries disappear — the drawer is their archive
  const visible = entries.filter((e) => !isMuted(snapshot, 'schedule', e.id));
  const quietCount = entries.length - visible.length;

  const sources = [...new Set(visible.map((e) => shortSource(e.source)))];

  // failures lead — a red run must never hide below the fold of healthy timers
  const failed = visible
    .filter((e) => e.lastStatus === 'fail')
    .sort((a, b) => (b.lastRun ?? '').localeCompare(a.lastRun ?? ''));
  const failedIds = new Set(failed.map((e) => e.id));
  const upcoming = visible
    .filter((e) => e.enabled && e.nextRun && !failedIds.has(e.id))
    // compare instants, not strings — hermes emits +03:00 offset ISO while cron/revuto emit Z
    .sort((a, b) => new Date(a.nextRun as string).getTime() - new Date(b.nextRun as string).getTime());
  // disabled entries are dead weight in a "what runs when" view — folded away by default
  const disabled = visible.filter((e) => !e.enabled && !failedIds.has(e.id));
  const rest = visible
    .filter((e) => e.enabled && !e.nextRun && !failedIds.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [...failed, ...upcoming, ...rest, ...(showDisabled ? disabled : [])].filter(
    (e) => filter === 'all' || shortSource(e.source) === filter,
  );
  const disabledCount = disabled.filter((e) => filter === 'all' || shortSource(e.source) === filter).length;

  return (
    <Panel
      title="Scheduled work"
      riseIndex={0}
      right={
        <span className="flex items-baseline gap-3">
          {sorted.length > 0 && (
            <span className="font-mono text-xs tabular-nums text-mist-faint">{sorted.length}</span>
          )}
          <RelTime iso={updatedAt} />
        </span>
      }
      quietCount={quietCount || undefined}
      onQuietClick={openQuiet}
    >
      {error && (
        <div className="mb-3 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {['all', ...sources].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full px-2.5 py-2 font-mono text-[11px] transition-colors sm:py-0.5 ${
              filter === s ? 'glass-raised text-mist' : 'text-mist-dim hover:text-mist'
            }`}
          >
            {s}
          </button>
        ))}
        {disabledCount > 0 && (
          <button
            onClick={() => setShowDisabled((v) => !v)}
            className={`ml-auto rounded-full px-2.5 py-2 font-mono text-[11px] transition-colors sm:py-0.5 ${
              showDisabled ? 'glass-raised text-mist' : 'text-mist-faint hover:text-mist'
            }`}
          >
            {showDisabled ? 'hide' : 'show'} {disabledCount} disabled
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <EmptyState>No timers or cron jobs were found.</EmptyState>
      ) : (
        <div>
          <div className={`${COLS} border-b py-1.5 font-mono text-[10px] uppercase tracking-widest text-mist-faint hairline`}>
            <span className="w-14 shrink-0 sm:w-16">src</span>
            <span className="min-w-0 flex-1">name</span>
            <span className="hidden w-36 shrink-0 lg:block">expr</span>
            <span className="w-16 shrink-0 text-right sm:w-20">next</span>
            <span className="hidden w-14 shrink-0 text-right sm:block">last</span>
            <span className="w-2 shrink-0" />
            <span className="hidden w-28 shrink-0 sm:block" />
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
                      <span className="w-14 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-center font-mono text-[10px] text-mist-dim sm:w-16">
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
                      <span className="w-16 shrink-0 text-right sm:w-20">
                        <NextRun iso={e.nextRun} />
                      </span>
                      <span className="hidden w-14 shrink-0 text-right sm:block">
                        <RelTime iso={e.lastRun} />
                      </span>
                      <Dot status={e.lastStatus === 'ok' ? 'running' : e.lastStatus === 'fail' ? 'error' : 'off'} />
                      <span className="hidden w-28 shrink-0 items-center justify-end gap-1 sm:flex">
                        {jobId && <RunNow jobId={jobId} />}
                        {e.muteable && <MuteButton kind="schedule" target={e.id} enforce />}
                      </span>
                    </div>
                  </Row>
                  {expanded && (
                    <div className="mb-1 space-y-1 rounded-lg bg-white/[0.03] px-3 py-2 text-xs sm:ml-19">
                      <div className="flex items-baseline gap-2">
                        <span className="w-12 shrink-0 font-mono text-[10px] uppercase tracking-widest text-mist-faint">id</span>
                        <CopyText text={e.id}>
                          <span className="min-w-0 break-all font-mono text-mist-dim">{e.id}</span>
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
                      <div className="mobile-actions flex flex-wrap justify-end gap-2 pt-2 sm:hidden">
                        {jobId && <RunNow jobId={jobId} />}
                        {e.muteable && <MuteButton kind="schedule" target={e.id} enforce />}
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
