import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { agentAction, isMuted } from '../api';
import { useTweenNumber } from '../hooks';
import { CopyText, Dot, EmptyState, MuteButton, Panel, RelTime, Row } from '../components/ui';
import type {
  RevutoJob,
  RevutoLog,
  RevutoModel,
  RevutoReviewer,
  RevutoDependency,
  RevutoScheduler,
  Snapshot,
} from '../../../shared/types';

/** one duration format for probes and jobs: 5538 → "5.5s", 42 → "42ms". */
function fmtMs(ms: number | null): string | null {
  if (ms === null) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function dependencyDot(s: RevutoDependency): string {
  if (s.activeState === 'active') return s.subState === 'running' ? 'running' : 'idle';
  if (s.activeState === 'failed') return 'error';
  if (s.activeState === 'inactive') return 'off';
  return 'unknown';
}

function schedulerDot(s: RevutoScheduler | null): string {
  if (!s) return 'unknown';
  if (!s.active) return 'off';
  return s.tasks > 0 ? 'running' : 'idle';
}

function probeDot(state: RevutoModel['probe']['state']): string {
  return state === 'ok' ? 'running' : state === 'failed' ? 'error' : state === 'disabled' ? 'off' : 'unknown';
}

/** classify a job row: 'real' (a non-zero review — the rare gem), 'quiet' (poll
 *  noise — the mass of reviewed=0 / skipped=0 must read as texture), 'failed'. */
function jobClass(j: RevutoJob): 'failed' | 'real' | 'quiet' | 'unknown' {
  if (j.status === 'failed') return 'failed';
  if (j.status === 'unknown') return 'unknown';
  // only a non-zero review earns jade — skips are routine (the counts strip agrees)
  const m = j.summary.match(/reviewed=(\d+)\s*\/\s*skipped=(\d+)/);
  return m && Number(m[1]) > 0 ? 'real' : 'quiet';
}

/** pulse-strip numeral — glides between snapshots (Spline Sans Mono is tabular, so the
 *  strip never jogs mid-tween). tone classes key off the real value upstream, not this. */
function TweenStat({ value, className }: { value: number; className: string }) {
  const display = useTweenNumber(value);
  return <span className={className}>{display}</span>;
}

const JOB_DOT: Record<ReturnType<typeof jobClass>, string> = {
  failed: 'error',
  real: 'running',
  quiet: 'idle',
  unknown: 'unknown',
};

function DependencyRow({ s }: { s: RevutoDependency }) {
  return (
    // 'since' is a systemd human string, not ISO — tooltip only, never RelTime
    <Row className="group" title={s.since ? `since ${s.since}` : undefined}>
      <div className="flex w-full min-w-0 items-center gap-2">
        <Dot status={dependencyDot(s)} />
        <span className="shrink-0 text-sm lowercase text-mist">{s.label}</span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <CopyText text={s.id}>
            <span className="block truncate text-left font-mono text-xs text-mist-faint" title={s.id}>
              {s.id}
            </span>
          </CopyText>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-mist-faint">
          {s.activeState === 'active' ? s.subState : s.activeState}
        </span>
      </div>
    </Row>
  );
}

/** Scheduler panel owns in-process start/stop controls — stop is destructive, so
 *  it uses the same two-click arm pattern as AgentsPanel fire(). */
function SchedulerCard({
  scheduler,
  dependencies,
  riseIndex,
}: {
  scheduler: RevutoScheduler | null;
  dependencies: RevutoDependency[];
  riseIndex: number;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; isError: boolean } | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resultTimer.current) clearTimeout(resultTimer.current);
    },
    [],
  );

  const run = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(action);
    try {
      const res = await agentAction('revuto', action);
      setResult({
        text: res.error ?? res.output ?? (res.ok ? 'ok' : 'failed'),
        isError: !res.ok || !!res.error,
      });
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setBusy(null);
      if (resultTimer.current) clearTimeout(resultTimer.current);
      resultTimer.current = setTimeout(() => setResult(null), 8000);
    }
  };

  const fire = (action: 'start' | 'stop' | 'restart') => {
    if (action === 'stop' && !armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    void run(action);
  };

  return (
    <Panel
      title="scheduler"
      riseIndex={riseIndex}
      right={
        <span className="flex items-center gap-2">
          {/* box-shadow joins the transition so the glass→glass-raised arm lifts instead of snapping */}
          <button
            type="button"
            disabled={busy === 'stop'}
            onClick={() => fire('stop')}
            className={`cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] transition-[color,background-color,border-color,box-shadow] hover:text-coral disabled:opacity-40 ${
              armed ? 'glass-raised text-coral' : 'glass text-coral/75'
            }`}
          >
            {busy === 'stop' ? '◌' : armed ? 'sure?' : 'stop'}
          </button>
          <button
            type="button"
            disabled={busy === 'restart'}
            onClick={() => fire('restart')}
            className="cursor-pointer rounded-md px-2 py-0.5 font-mono text-[11px] text-mist-dim transition-colors glass hover:text-mist disabled:opacity-40"
          >
            {busy === 'restart' ? '◌' : 'reload'}
          </button>
        </span>
      }
    >
      {result && (
        <div
          className={`mb-1 truncate px-2.5 font-mono text-xs ${result.isError ? 'text-coral' : 'text-mist-faint'}`}
          title={result.text}
        >
          {result.text}
        </div>
      )}
      <Row className="group">
        <div className="flex w-full min-w-0 items-center gap-2">
          <Dot status={schedulerDot(scheduler)} />
          <span className="shrink-0 text-sm lowercase text-mist">in-process</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-mist-faint">
            {scheduler ? `${scheduler.repos} reviewers, ${scheduler.tasks} cron tasks` : 'waiting for scheduler status'}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-mist-faint">
            {scheduler?.active ? 'active' : 'inactive'}
          </span>
        </div>
      </Row>
      {dependencies.length > 0 && (
        <div className="mt-3">
          <div className="px-2.5 pb-1 font-mono text-[10px] uppercase text-mist-faint">
            dependencies
          </div>
          {dependencies.map((s) => <DependencyRow key={s.id} s={s} />)}
        </div>
      )}
    </Panel>
  );
}

function ModelRow({ m }: { m: RevutoModel }) {
  return (
    <Row className="group">
      <div className="flex w-full min-w-0 items-center gap-2">
        <Dot status={probeDot(m.probe.state)} />
        <span className={`w-16 shrink-0 text-sm ${m.enabled ? 'text-mist' : 'text-mist-faint'}`}>{m.role}</span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <CopyText text={m.model}>
            <span className="block truncate text-left font-mono text-xs text-mist-dim" title={m.model}>
              {m.model}
            </span>
          </CopyText>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-mist-faint">{m.name}</span>
        {m.probe.error && (
          <span className="min-w-0 max-w-32 truncate font-mono text-[11px] text-coral" title={m.probe.error}>
            {m.probe.error}
          </span>
        )}
        <span
          className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-mist-faint"
          title={m.probe.checkedAt ? `probed ${new Date(m.probe.checkedAt).toLocaleString()}` : undefined}
        >
          {fmtMs(m.probe.ms) ?? '—'}
        </span>
      </div>
    </Row>
  );
}

function ReviewerRow({ r }: { r: RevutoReviewer }) {
  return (
    <Row
      className="group"
      title={`review ${r.reviewSchedule}${r.autoActivate ? ' · auto-activate' : ''}`}
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        <Dot status={r.paused ? 'off' : 'running'} />
        <div className="min-w-0 flex-1 overflow-hidden">
          <CopyText text={r.repo}>
            <span className="block truncate text-left font-mono text-xs text-mist" title={r.repo}>
              {r.repo}
            </span>
          </CopyText>
        </div>
        {r.paused ? (
          <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-mist-faint">
            paused
          </span>
        ) : (
          // enforce really pauses the repo via the revuto cli — the mute engine handles it
          <MuteButton kind="agent-resource" target={`revuto:${r.repo}`} enforce label="pause" />
        )}
      </div>
    </Row>
  );
}

function JobRow({ j }: { j: RevutoJob }) {
  const cls = jobClass(j);
  const repoTone = cls === 'real' || cls === 'failed' ? 'text-mist' : 'text-mist-faint';
  const summaryTone = cls === 'failed' ? 'text-coral' : cls === 'real' ? 'text-jade' : 'text-mist-faint';
  return (
    <Row className="group">
      <div className="flex w-full min-w-0 items-center gap-2">
        {/* a real review is the found gem in the poll texture — its jade dot breathes
            (styles.css stills .breathe under prefers-reduced-motion) */}
        {cls === 'real' ? (
          <span className="inline-flex shrink-0 breathe">
            <Dot status={JOB_DOT[cls]} />
          </span>
        ) : (
          <Dot status={JOB_DOT[cls]} />
        )}
        <span className="w-9 shrink-0 text-right">
          <RelTime iso={j.timestamp} />
        </span>
        {/* fixed chip slot — 'review' vs 'learn'/'decay' must not jog the repo column */}
        <span
          className={`w-14 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-center font-mono text-[10px] ${
            cls === 'quiet' ? 'text-mist-faint' : 'text-mist-dim'
          }`}
        >
          {j.job}
        </span>
        <div className="w-32 shrink-0 overflow-hidden xl:w-40">
          <CopyText text={j.repo}>
            <span className={`block truncate text-left font-mono text-xs ${repoTone}`} title={j.repo}>
              {j.repo}
            </span>
          </CopyText>
        </div>
        <span className={`min-w-0 flex-1 truncate font-mono text-xs ${summaryTone}`} title={j.summary}>
          {j.summary}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-mist-faint">
          {fmtMs(j.durationMs) ?? ''}
        </span>
      </div>
    </Row>
  );
}

function LogLine({ l }: { l: RevutoLog }) {
  // two tones only (AgentsPanel activity idiom) — upstream tags routine skip cycles
  // 'warn', and amber on poll noise would burn the act-now signal
  const tone = l.level === 'error' ? 'text-coral' : 'text-mist-dim';
  return (
    // px-2.5 keeps the time rail on the same line as job rows and the empty state
    <div className="flex items-baseline gap-2 px-2.5 py-0.5">
      {/* fixed time slot so the mono feed reads as columns ('29s' vs '1m' must not shift) */}
      <span className="w-9 shrink-0 text-right">
        <RelTime iso={l.timestamp} />
      </span>
      <span className={`min-w-0 truncate ${tone}`} title={l.message}>
        {l.message}
      </span>
    </div>
  );
}

export default function RevutoPanel({
  snapshot,
  onOpenQuiet,
}: {
  snapshot: Snapshot;
  onOpenQuiet: () => void;
}) {
  const r = snapshot.revuto;
  // rollout skew: a web bundle ahead of a not-yet-restarted server has no revuto
  // section — render a hint instead of taking down the whole tree
  if (!r) {
    return (
      <Panel title="revuto">
        <EmptyState>server snapshot has no revuto section — restart the atrium daemon</EmptyState>
      </Panel>
    );
  }
  const { counts, schedules, limits, store } = r;

  // quiet = archive: muted reviewers unmount; the quiet chip is the way back
  const visibleReviewers = r.reviewers.filter(
    (rv) => !isMuted(snapshot, 'agent-resource', `revuto:${rv.repo}`),
  );
  const quietReviewers = r.reviewers.length - visibleReviewers.length;

  const jobs = r.jobs; // newest first from the server; header count must match the list
  const logs = r.logs;

  // never polled (failure paths always set error) or polled but upstream still warming up
  const fresh =
    (!r.up && r.updatedAt === null && r.error === null) ||
    (r.up &&
      !counts &&
      r.scheduler === null &&
      r.dependencies.length === 0 &&
      r.models.length === 0 &&
      r.reviewers.length === 0 &&
      r.jobs.length === 0 &&
      r.logs.length === 0);
  if (fresh) {
    return (
      <Panel title="revuto">
        <EmptyState>waiting for first snapshot</EmptyState>
      </Panel>
    );
  }

  return (
    <div>
      {!r.up && (
        // surface scheduler/core staleness without implying the legacy dashboard exists
        <div className="mb-3 flex min-w-0 items-center gap-2 px-1 font-mono text-xs">
          <Dot status="error" />
          <span className="shrink-0 text-coral">revuto status unavailable</span>
          {r.error && (
            <span className="min-w-0 truncate text-mist-faint" title={r.error}>
              {r.error}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-[11px] text-mist-faint">
            last data <RelTime iso={r.updatedAt} />
          </span>
        </div>
      )}

      {/* config/vault errors can arrive while the in-process scheduler is still alive */}
      {r.up && r.error && (
        <div className="mb-3 flex min-w-0 items-center gap-2 px-1 font-mono text-xs">
          <Dot status="error" />
          <span className="min-w-0 truncate text-coral" title={r.error}>
            {r.error}
          </span>
        </div>
      )}

      {counts && (
        <section
          className="glass rise mb-4 flex flex-wrap items-baseline gap-x-8 gap-y-3 px-4 py-4 xl:px-5"
          style={{ '--rise-i': 0 } as CSSProperties}
        >
          <div className="flex items-baseline gap-1.5">
            <TweenStat value={counts.reviewers} className="font-mono text-xl leading-none tabular-nums text-mist" />
            <span className="text-[11px] text-mist-faint">reviewers</span>
            {counts.pausedReviewers > 0 && (
              <span className="font-mono text-[11px] tabular-nums text-mist-faint">
                · {counts.pausedReviewers} paused
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-1.5">
            <TweenStat value={counts.recentJobs} className="font-mono text-xl leading-none tabular-nums text-mist" />
            <span className="text-[11px] text-mist-faint">jobs</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <TweenStat value={counts.schedulerTasks} className="font-mono text-xl leading-none tabular-nums text-mist" />
            <span className="text-[11px] text-mist-faint">cron tasks</span>
          </div>
          {counts.dependenciesTotal > 0 && (
            <div className="flex items-baseline gap-1.5">
              <TweenStat value={counts.dependenciesReady} className="font-mono text-xl leading-none tabular-nums text-mist" />
              <span className="text-[11px] text-mist-faint">/ {counts.dependenciesTotal} deps</span>
            </div>
          )}
          <div className="flex items-baseline gap-1.5">
            <TweenStat
              value={counts.recentFailures}
              className={`font-mono text-xl leading-none tabular-nums ${
                counts.recentFailures > 0 ? 'text-coral' : 'text-mist-faint'
              }`}
            />
            <span className="text-[11px] text-mist-faint">failures</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <TweenStat
              value={counts.reviewed}
              className={`font-mono text-xl leading-none tabular-nums ${
                counts.reviewed > 0 ? 'text-jade' : 'text-mist-faint'
              }`}
            />
            <span className="text-[11px] text-mist-faint">reviewed ·</span>
            <TweenStat value={counts.skipped} className="font-mono text-xl leading-none tabular-nums text-mist-dim" />
            <span className="text-[11px] text-mist-faint">skipped</span>
          </div>
          <span className="ml-auto flex shrink-0 items-baseline gap-1.5 font-mono text-[11px] text-mist-faint">
            updated <RelTime iso={r.updatedAt} />
          </span>
        </section>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <SchedulerCard scheduler={r.scheduler} dependencies={r.dependencies} riseIndex={1} />

        <Panel title="models" riseIndex={2}>
          {r.models.length === 0 ? (
            <EmptyState>no models</EmptyState>
          ) : (
            r.models.map((m) => <ModelRow key={m.role} m={m} />)
          )}
        </Panel>

        <Panel
          title="reviewers"
          riseIndex={3}
          className="xl:col-span-2"
          quietCount={quietReviewers || undefined}
          onQuietClick={onOpenQuiet}
        >
          {visibleReviewers.length === 0 ? (
            <EmptyState>{r.reviewers.length > 0 ? 'all reviewers quieted' : 'no reviewers'}</EmptyState>
          ) : (
            <div className="grid gap-x-2 sm:grid-cols-2 2xl:grid-cols-3">
              {visibleReviewers.map((rv) => (
                <ReviewerRow key={rv.repo} r={rv} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="jobs"
          riseIndex={4}
          right={
            r.jobs.length > 0 ? (
              <span className="font-mono text-xs tabular-nums text-mist-faint">{r.jobs.length}</span>
            ) : undefined
          }
        >
          {jobs.length === 0 ? (
            <EmptyState>no jobs lately — review runs land here</EmptyState>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {jobs.map((j, i) => (
                <JobRow key={`${j.timestamp}-${j.repo}-${i}`} j={j} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="logs"
          riseIndex={5}
          right={
            r.logs.length > 0 ? (
              <span className="font-mono text-xs tabular-nums text-mist-faint">{r.logs.length}</span>
            ) : undefined
          }
        >
          {logs.length === 0 ? (
            <EmptyState>nothing logged lately</EmptyState>
          ) : (
            <div className="max-h-80 overflow-y-auto font-mono text-xs">
              {logs.map((l, i) => (
                <LogLine key={`${l.timestamp}-${i}`} l={l} />
              ))}
            </div>
          )}
        </Panel>

        {(schedules || limits || store) && (
          <Panel title="config" riseIndex={6} className="xl:col-span-2">
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-2.5 font-mono text-xs tabular-nums text-mist-faint">
              {schedules && (
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {/* '·' between entries — cron exprs are mostly asterisks and merge without it */}
                  {(['review', 'learn', 'decay'] as const).map((k, i) => (
                    <span key={k} className="flex items-baseline gap-x-2">
                      {i > 0 && <span>·</span>}
                      <CopyText text={schedules[k]}>
                        <span className="whitespace-nowrap">
                          <span className="text-mist-dim">{k}</span> {schedules[k]}
                        </span>
                      </CopyText>
                    </span>
                  ))}
                </span>
              )}
              {limits && (
                <span className="whitespace-nowrap">
                  {limits.dailyReviews} reviews/day · {limits.dailyLearn} learn/day ·{' '}
                  {(limits.dailyTokens / 1e6).toFixed(1)}M tokens/day · {limits.maxSteps} steps
                </span>
              )}
              {store && (
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-mist-dim">{store.backend}</span>
                  {store.namespace && <span className="whitespace-nowrap">· {store.namespace}</span>}
                  {store.url && (
                    <CopyText text={store.url}>
                      <span className="truncate" title={store.url}>
                        @ {store.url.replace(/^[a-z+]+:\/\//, '')}
                      </span>
                    </CopyText>
                  )}
                </span>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
