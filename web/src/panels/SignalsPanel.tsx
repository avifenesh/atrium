import { useMemo, useState } from 'react';
import { markSignalsReviewed, saveSignalsWatch, setSignalLead } from '../api';
import Spark from '../components/Spark';
import { EmptyState, Panel, RelTime, Row, SectionLabel } from '../components/ui';
import type { SignalItem, Snapshot } from '../../../shared/types';

/** One surface for "the outside world noticed my work": mentions (HN/GitHub/web),
 *  HF demand radar (releases + threads asking for shippable formats), and the
 *  exposure counters (stars, views, downloads) with day-over-day deltas.
 *  The watch lists are edited HERE — no code change, no restart. */

function NewDot({ show }: { show: boolean }) {
  return (
    <span className="w-1.5 shrink-0 self-center" aria-hidden="true">
      {show && <span className="block h-1.5 w-1.5 rounded-full bg-jade" />}
    </span>
  );
}

function SourceChip({ children }: { children: string }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded border hairline px-1.5 py-px font-mono text-[10px] text-mist-faint">
      {children}
    </span>
  );
}

function Delta({ delta }: { delta: number | null }) {
  if (delta === null || delta === 0) return null;
  return (
    <span className={`shrink-0 font-mono text-xs tabular-nums ${delta > 0 ? 'text-jade' : 'text-coral'}`}>
      {delta > 0 ? `+${delta}` : delta}
    </span>
  );
}

/** Lead actions on a mention/thread row: engaged = went and commented, skip = not
 *  worth it. One decision per row — this is the "where do I go comment" queue. */
export function LeadButtons({ s }: { s: SignalItem }) {
  const [busy, setBusy] = useState(false);
  const act = async (status: 'engaged' | 'dismissed' | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await setSignalLead(s.id, status);
    } finally {
      setBusy(false);
    }
  };
  if (s.lead) {
    return (
      <button
        type="button"
        disabled={busy}
        title={`${s.lead.status} — click to undo`}
        onClick={(e) => {
          e.stopPropagation();
          void act(null);
        }}
        className={`shrink-0 cursor-pointer whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] ${
          s.lead.status === 'engaged' ? 'bg-jade/10 text-jade' : 'bg-white/5 text-mist-faint'
        }`}
      >
        {s.lead.status === 'engaged' ? 'engaged' : 'skipped'}
      </button>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={busy}
        title="mark engaged — I commented / answered this"
        onClick={(e) => {
          e.stopPropagation();
          void act('engaged');
        }}
        className="hover-cluster shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-jade"
      >
        engaged
      </button>
      <button
        type="button"
        disabled={busy}
        title="skip — not a lead"
        onClick={(e) => {
          e.stopPropagation();
          void act('dismissed');
        }}
        className="hover-cluster shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-amber"
      >
        skip
      </button>
    </span>
  );
}

export function MentionRow({ s, isNew }: { s: SignalItem; isNew: boolean }) {
  const dimmed = s.lead?.status === 'dismissed';
  return (
    <Row href={s.url ?? undefined} title={s.title} className="flex-wrap sm:flex-nowrap">
      <NewDot show={isNew && !s.lead} />
      <SourceChip>{`${s.source} · ${s.entity}`}</SourceChip>
      <span className={`min-w-0 flex-1 truncate text-sm ${dimmed ? 'text-mist-faint' : 'text-mist'}`}>{s.title}</span>
      <LeadButtons s={s} />
      <RelTime iso={s.occurredAt ?? s.firstSeenAt} />
    </Row>
  );
}

export function DemandRow({ s, isNew }: { s: SignalItem; isNew: boolean }) {
  const dimmed = s.lead?.status === 'dismissed';
  return (
    <Row href={s.url ?? undefined} title={s.title} className="flex-wrap sm:flex-nowrap">
      <NewDot show={isNew && !s.lead} />
      <SourceChip>{s.kind === 'release' ? `release · ${s.entity}` : s.entity}</SourceChip>
      <span className={`min-w-0 flex-1 truncate text-sm ${dimmed ? 'text-mist-faint' : 'text-mist'}`}>{s.title}</span>
      {s.kind === 'demand-thread' && s.count !== null && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-amber" title={`${s.count} reactions`}>
          {s.count}❤
        </span>
      )}
      {s.detail && (
        <span className="hidden max-w-[16rem] shrink-0 truncate font-mono text-[11px] text-mist-faint lg:inline" title={s.detail}>
          {s.detail}
        </span>
      )}
      {s.kind === 'demand-thread' && <LeadButtons s={s} />}
      <RelTime iso={s.occurredAt ?? s.firstSeenAt} />
    </Row>
  );
}

export function CounterRow({ s }: { s: SignalItem }) {
  return (
    <Row href={s.url ?? undefined} title={`${s.entity} — ${s.title}`}>
      <span className="min-w-0 max-w-[14rem] shrink-0 truncate font-mono text-xs text-mist-dim" title={s.entity}>
        {s.entity}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-mist-dim">{s.title}</span>
      {s.spark && s.spark.length >= 2 && <Spark series={s.spark} className="text-mist-faint" />}
      <span className="shrink-0 font-mono text-sm tabular-nums text-mist">{s.count ?? '—'}</span>
      <Delta delta={s.delta} />
      {s.detail && (
        <span className="hidden max-w-[12rem] shrink-0 truncate font-mono text-[11px] text-mist-faint sm:inline" title={s.detail}>
          {s.detail}
        </span>
      )}
    </Row>
  );
}

const FIELD =
  'w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-xs text-mist placeholder:text-mist-faint focus:border-amber/50 focus:outline-none';
const LABEL = 'mb-1 block font-mono text-[10px] uppercase tracking-widest text-mist-faint';

function WatchEditor({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const watch = snapshot.signals.watch;
  const [terms, setTerms] = useState(watch.terms.join('\n'));
  const [keywords, setKeywords] = useState(watch.demandKeywords.join('\n'));
  const [radar, setRadar] = useState(JSON.stringify(watch.radarWatch, null, 2));
  const [repos, setRepos] = useState((watch.repos ?? []).join('\n'));
  const [hfModels, setHfModels] = useState((watch.hfModels ?? []).join('\n'));
  const [crates, setCrates] = useState((watch.crates ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = (text: string) => text.split('\n').map((t) => t.trim()).filter(Boolean);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let radarWatch;
      try {
        radarWatch = JSON.parse(radar);
      } catch {
        throw new Error('radar watch must be valid JSON (array of { family, org, ... })');
      }
      await saveSignalsWatch({
        terms: lines(terms),
        demandKeywords: lines(keywords),
        radarWatch,
        repos: lines(repos),
        hfModels: lines(hfModels),
        crates: lines(crates),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Watch lists" rise={false} className="col-span-12">
      <p className="mb-3 px-2.5 text-sm text-mist-dim">
        The business portfolio, saved to <span className="font-mono text-xs">~/.config/atrium/signals.json</span> and
        picked up by the collectors on their next pass — the hourly mention radar and the daily exposure snapshot
        read the same file.
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div>
          <label className={LABEL} htmlFor="signals-terms">
            mention terms (one per line)
          </label>
          <textarea id="signals-terms" rows={10} className={FIELD} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="signals-keywords">
            demand keywords (one per line)
          </label>
          <textarea
            id="signals-keywords"
            rows={10}
            className={FIELD}
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="signals-radar">
            hf radar watch (json)
          </label>
          <textarea id="signals-radar" rows={10} className={FIELD} value={radar} onChange={(e) => setRadar(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="signals-repos">
            counter repos (owner/name per line)
          </label>
          <textarea id="signals-repos" rows={4} className={FIELD} value={repos} onChange={(e) => setRepos(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="signals-hf">
            counter hf models (one per line)
          </label>
          <textarea id="signals-hf" rows={4} className={FIELD} value={hfModels} onChange={(e) => setHfModels(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="signals-crates">
            counter crates (one per line)
          </label>
          <textarea id="signals-crates" rows={4} className={FIELD} value={crates} onChange={(e) => setCrates(e.target.value)} />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {error && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-coral" title={error}>
            {error}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded px-2 py-1 font-mono text-[11px] text-mist-faint hover:text-mist"
        >
          cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="cursor-pointer rounded-md bg-amber px-3 py-1.5 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-40"
        >
          {busy ? '…' : 'Save'}
        </button>
      </div>
    </Panel>
  );
}

export default function SignalsPanel({ snapshot }: { snapshot: Snapshot }) {
  const sig = snapshot.signals;
  const [mode, setMode] = useState<'all' | 'new' | 'engaged'>('all');
  const [editing, setEditing] = useState(false);
  const [marking, setMarking] = useState(false);

  const reviewedAt = sig.lastReviewedAt;
  const isNew = (s: SignalItem) => !reviewedAt || s.firstSeenAt > reviewedAt;

  const { mentions, demand, counters, newCount, engagedCount } = useMemo(() => {
    const mentions = sig.items.filter((s) => s.kind === 'mention');
    const demand = sig.items.filter((s) => s.kind === 'release' || s.kind === 'demand-thread');
    const counters = sig.items.filter((s) => s.kind === 'counter');
    const newCount = sig.items.filter((s) => isNew(s) && !s.lead).length;
    const engagedCount = sig.items.filter((s) => s.lead?.status === 'engaged').length;
    return { mentions, demand, counters, newCount, engagedCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig.items, reviewedAt]);

  const inMode = (s: SignalItem) =>
    mode === 'all' ? true : mode === 'engaged' ? s.lead?.status === 'engaged' : isNew(s) && !s.lead;
  const shownMentions = mentions.filter(inMode);
  const shownDemand = demand.filter(inMode);

  const markReviewed = async () => {
    if (marking) return;
    setMarking(true);
    try {
      await markSignalsReviewed();
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="grid grid-cols-12 gap-5">
      <header className="col-span-12 flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 font-mono text-xs">
          {(
            [
              ['all', 'all'],
              ['new', newCount > 0 ? `new · ${newCount}` : 'new'],
              ['engaged', engagedCount > 0 ? `engaged · ${engagedCount}` : 'engaged'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`cursor-pointer rounded px-2 py-1 transition-colors ${mode === value ? 'bg-white/10 text-mist' : 'text-mist-faint hover:text-mist'}`}
            >
              {label}
            </button>
          ))}
          {reviewedAt && (
            <span className="text-mist-faint">
              reviewed <RelTime iso={reviewedAt} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sig.error && (
            <span className="max-w-72 truncate font-mono text-xs text-coral" title={sig.error}>
              {sig.error}
            </span>
          )}
          <RelTime iso={sig.updatedAt} />
          <button
            type="button"
            disabled={marking}
            onClick={() => void markReviewed()}
            title="everything currently here stops counting as new"
            className="cursor-pointer rounded px-2 py-1 font-mono text-[11px] text-mist-faint transition-colors hover:text-jade disabled:opacity-40"
          >
            {marking ? '…' : 'mark reviewed'}
          </button>
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className="cursor-pointer rounded px-2 py-1 font-mono text-[11px] text-mist-faint transition-colors hover:text-amber"
          >
            {editing ? 'close watch lists' : 'edit watch lists'}
          </button>
        </div>
      </header>

      {editing && <WatchEditor snapshot={snapshot} onClose={() => setEditing(false)} />}

      <Panel
        title="Mentions"
        riseIndex={0}
        className="col-span-12 lg:col-span-7"
        right={
          shownMentions.length > 0 ? (
            <span className="font-mono text-xs tabular-nums text-mist-faint">{shownMentions.length}</span>
          ) : undefined
        }
      >
        {shownMentions.length === 0 ? (
          <EmptyState>{mode !== 'all' ? `Nothing ${mode === 'new' ? 'new since the last review' : 'engaged yet'}.` : 'No mentions recorded yet.'}</EmptyState>
        ) : (
          <div className="max-h-[32rem] space-y-0.5 overflow-y-auto">
            {shownMentions.map((s) => (
              <MentionRow key={s.id} s={s} isNew={isNew(s)} />
            ))}
          </div>
        )}
      </Panel>

      <div className="col-span-12 flex flex-col gap-5 lg:col-span-5">
        <Panel
          title="Demand radar"
          riseIndex={1}
          right={
            shownDemand.length > 0 ? (
              <span className="font-mono text-xs tabular-nums text-mist-faint">{shownDemand.length}</span>
            ) : undefined
          }
        >
          {shownDemand.length === 0 ? (
            <EmptyState>
              {sig.watch.radarWatch.length === 0
                ? 'No families watched — edit the watch lists to add some.'
                : mode !== 'all'
                  ? `Nothing ${mode === 'new' ? 'new since the last review' : 'engaged yet'}.`
                  : 'No releases or demand threads right now.'}
            </EmptyState>
          ) : (
            <div className="max-h-[20rem] space-y-0.5 overflow-y-auto">
              {shownDemand.map((s) => (
                <DemandRow key={s.id} s={s} isNew={isNew(s)} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Counters" riseIndex={2}>
          {counters.length === 0 ? (
            <EmptyState>No exposure snapshot yet.</EmptyState>
          ) : (
            <div className="max-h-[24rem] space-y-0.5 overflow-y-auto">
              {counters.map((s) => (
                <CounterRow key={s.id} s={s} />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {sig.sources.length > 0 && (
        <div className="col-span-12 px-1">
          <SectionLabel>Sources</SectionLabel>
          <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-mist-faint">
            {sig.sources.map((s) => (
              <span key={s.id} className="flex items-center gap-2">
                {s.id}
                <RelTime iso={s.updatedAt} />
                {s.error && (
                  <span className="max-w-56 truncate text-coral" title={s.error}>
                    {s.error}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
