// Standalone CRM — the one atrium surface that leaves the machine (crm host via
// Cloudflare tunnel + Access; also served at /crm.html on loopback/tailnet).
//
// Deliberately self-contained: it talks ONLY to /api/crm/* — the snapshot, the
// SSE stream and every other atrium API are blocked on the public host, so this
// page must not want them. The business overview (/api/crm/overview) is
// aggregated server-side for the same reason.
//
// Desktop-first, phone-capable: ≥lg the pipeline is a kanban board (a column
// per stage) under the numbers band; below lg it collapses to the filterable
// list with the same detail sheet.
//
// Three item kinds, three jobs: directions (the seller hunt's new ways to sell —
// decide, then act), leads (people publicly failing to run a model — answer
// them), accounts (people already inside — keep them). The kind row splits the
// screen by job; the stage row and search cut within one.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CrmItem, CrmOverview, CrmPipeline, CrmStage } from '../../../shared/types';
import { Board } from './Board';
import { GrowthTab, HealthTab, MoneyTab, PulseStrip } from './Overview';
import { CRM_STAGES, STAGE_LABEL, STAGE_TONE } from './stages';

const POLL_MS = 60_000;

const KIND_LABEL: Record<CrmItem['kind'], string> = {
  direction: 'directions',
  lead: 'leads',
  account: 'accounts',
};
const KIND_TONE: Record<CrmItem['kind'], string> = {
  direction: 'text-amber',
  lead: 'text-slate-glow',
  account: 'text-jade',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const post = (path: string, body: unknown) =>
  api<{ ok: true }>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function relDay(iso: string | null): string {
  if (!iso) return '';
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  if (Number.isNaN(days)) return iso;
  if (days === 0) return 'today';
  if (days < 0) return `${-days}d overdue`;
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

function age(iso: string | null): string {
  if (!iso) return '';
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (Number.isNaN(hours) || hours < 0) return '';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function StageBadge({ stage, overridden }: { stage: CrmStage; overridden: boolean }) {
  return (
    <span className={`shrink-0 rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] ${STAGE_TONE[stage]}`}>
      {STAGE_LABEL[stage]}
      {overridden && ' *'}
    </span>
  );
}

function ItemCard({ item, onOpen }: { item: CrmItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3 text-left transition-colors hover:border-white/20"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-mist">{item.title}</span>
        <StageBadge stage={item.stage} overridden={item.overridden} />
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-mist-faint">
        <span className={KIND_TONE[item.kind]}>{item.kind}</span>
        {item.source && item.source !== 'seller' && <span>{item.source}</span>}
        {item.subtitle && <span className="min-w-0 truncate">{item.subtitle}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {item.activityAt && !item.followUpAt && <span>{age(item.activityAt)}</span>}
          {item.followUpAt && (
            <span className={item.followUpDue ? 'text-amber' : ''}>⏰ {relDay(item.followUpAt)}</span>
          )}
        </span>
      </div>
      {/* directions carry their pitch — a title alone is not enough to judge one */}
      {item.kind === 'direction' && item.detail && (
        <div className="mt-1.5 line-clamp-2 whitespace-pre-line text-xs text-mist-dim">{item.detail}</div>
      )}
    </button>
  );
}

function Detail({ item, onClose, onChanged }: { item: CrmItem; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState('');
  const [summary, setSummary] = useState('');

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-white/10 bg-ink-2 p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-base text-mist">{item.title}</div>
            <div className="mt-0.5 font-mono text-[11px] text-mist-faint">
              <span className={KIND_TONE[item.kind]}>{item.kind}</span>
              {item.source && ` · ${item.source}`}
              {item.subtitle && ` · ${item.subtitle}`}
              {item.activityAt && ` · ${age(item.activityAt)} ago`}
            </div>
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-[11px] text-slate-glow underline">
                {item.url}
              </a>
            )}
          </div>
          <button type="button" onClick={onClose} className="shrink-0 cursor-pointer px-2 py-1 font-mono text-xs text-mist-faint">
            close
          </button>
        </div>

        {item.detail && (
          <div className="mt-3 whitespace-pre-line rounded-lg border border-white/8 px-3 py-2 text-xs text-mist-dim">
            {item.detail}
          </div>
        )}

        {/* stage — one tap per column; tapping the derived stage clears the override */}
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">
            stage{item.overridden && ` (pinned — sources say ${STAGE_LABEL[item.derivedStage]})`}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CRM_STAGES.map((stage) => (
              <button
                key={stage}
                type="button"
                disabled={busy}
                onClick={() =>
                  run(() => post('/api/crm/entry', { id: item.id, stage: stage === item.derivedStage ? null : stage }))
                }
                className={`cursor-pointer rounded-lg border px-2.5 py-1.5 font-mono text-[11px] ${
                  stage === item.stage ? `border-white/25 bg-white/5 ${STAGE_TONE[stage]}` : 'border-white/8 text-mist-dim'
                }`}
              >
                {STAGE_LABEL[stage]}
              </button>
            ))}
          </div>
        </div>

        {/* follow-up */}
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">follow-up</div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              defaultValue={item.followUpAt?.slice(0, 10) ?? ''}
              disabled={busy}
              onChange={(e) =>
                run(() =>
                  post('/api/crm/entry', {
                    id: item.id,
                    followUpAt: e.target.value ? new Date(`${e.target.value}T09:00:00`).toISOString() : null,
                  }),
                )
              }
              className="rounded-lg border border-white/10 bg-ink px-2.5 py-1.5 font-mono text-xs text-mist"
            />
            {item.followUpAt && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => post('/api/crm/entry', { id: item.id, followUpAt: null }))}
                className="cursor-pointer font-mono text-[11px] text-mist-faint underline"
              >
                clear
              </button>
            )}
          </div>
        </div>

        {/* contact log */}
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">contact log</div>
          <div className="space-y-1.5">
            {item.contacts.map((c) => (
              <div key={c.at} className="rounded-lg border border-white/8 px-2.5 py-1.5">
                <div className="font-mono text-[10px] text-mist-faint">
                  {c.at.slice(0, 10)} · {c.channel}
                </div>
                <div className="text-xs text-mist-dim">{c.summary}</div>
              </div>
            ))}
            <div className="flex gap-1.5">
              <input
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder="channel"
                className="w-24 rounded-lg border border-white/10 bg-ink px-2 py-1.5 font-mono text-xs text-mist placeholder:text-mist-faint"
              />
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="what happened"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink px-2 py-1.5 text-xs text-mist placeholder:text-mist-faint"
              />
              <button
                type="button"
                disabled={busy || !channel.trim() || !summary.trim()}
                onClick={() =>
                  run(async () => {
                    await post('/api/crm/contact', { id: item.id, channel, summary });
                    setChannel('');
                    setSummary('');
                  })
                }
                className="shrink-0 cursor-pointer rounded-lg border border-white/15 px-2.5 font-mono text-xs text-mist disabled:opacity-40"
              >
                log
              </button>
            </div>
          </div>
        </div>

        {/* notes */}
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">notes</div>
          <div className="space-y-1.5">
            {item.notes.map((n) => (
              <div key={n.at} className="rounded-lg border border-white/8 px-2.5 py-1.5">
                <div className="font-mono text-[10px] text-mist-faint">{n.at.slice(0, 10)}</div>
                <div className="text-xs text-mist-dim">{n.text}</div>
              </div>
            ))}
            <div className="flex gap-1.5">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="add a note"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink px-2 py-1.5 text-xs text-mist placeholder:text-mist-faint"
              />
              <button
                type="button"
                disabled={busy || !note.trim()}
                onClick={() =>
                  run(async () => {
                    await post('/api/crm/note', { id: item.id, text: note });
                    setNote('');
                  })
                }
                className="shrink-0 cursor-pointer rounded-lg border border-white/15 px-2.5 font-mono text-xs text-mist disabled:opacity-40"
              >
                add
              </button>
            </div>
          </div>
        </div>

        {error && <div className="mt-3 font-mono text-xs text-coral">{error}</div>}
      </div>
    </div>
  );
}

type KindFilter = 'all' | CrmItem['kind'];
type StageFilter = 'any' | 'due' | CrmStage;

// Tabs — hash-routed so a refresh (and the phone's back button) keeps the page.
const TABS = ['pipeline', 'money', 'growth', 'health'] as const;
type Tab = (typeof TABS)[number];
const readTab = (): Tab => {
  const h = window.location.hash.replace('#', '');
  return (TABS as readonly string[]).includes(h) ? (h as Tab) : 'pipeline';
};

const matches = (i: CrmItem, needle: string) =>
  `${i.title} ${i.subtitle ?? ''} ${i.source ?? ''} ${i.detail ?? ''}`.toLowerCase().includes(needle);

const chipClass = (active: boolean, extra = '') =>
  `shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
    active ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
  } ${extra}`;

export function CrmApp() {
  const [pipeline, setPipeline] = useState<CrmPipeline | null>(null);
  const [overview, setOverview] = useState<CrmOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [stage, setStage] = useState<StageFilter>('any');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(readTab);

  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const goTab = (next: Tab) => {
    window.location.hash = next === 'pipeline' ? '' : next;
    setTab(next);
  };

  const refresh = useCallback(async () => {
    try {
      const [nextPipeline, nextOverview] = await Promise.all([
        api<CrmPipeline>('/api/crm/pipeline'),
        api<CrmOverview>('/api/crm/overview'),
      ]);
      setPipeline(nextPipeline);
      setOverview(nextOverview);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const items = pipeline?.items ?? [];
  const due = useMemo(() => items.filter((i) => i.followUpDue), [items]);
  const kindCounts = useMemo(() => {
    const map = new Map<CrmItem['kind'], number>();
    for (const item of items) map.set(item.kind, (map.get(item.kind) ?? 0) + 1);
    return map;
  }, [items]);

  // stage counts respect the kind filter, so "leads → new 12" answers the real
  // question ("how many untouched leads"), not a blended number
  const inKind = kind === 'all' ? items : items.filter((i) => i.kind === kind);
  const stageCounts = useMemo(() => {
    const map = new Map<CrmStage, number>();
    for (const item of inKind) map.set(item.stage, (map.get(item.stage) ?? 0) + 1);
    return map;
  }, [inKind]);

  const needle = query.trim().toLowerCase();
  const visible = inKind.filter((i) => {
    if (stage === 'due' && !i.followUpDue) return false;
    if (stage !== 'any' && stage !== 'due' && i.stage !== stage) return false;
    return !needle || matches(i, needle);
  });
  const open = openId ? items.find((i) => i.id === openId) ?? null : null;

  return (
    <div className="mx-auto max-w-7xl px-3 pb-16 pt-4 sm:px-5">
      <header className="mb-3 flex items-baseline gap-3">
        <h1 className="font-display text-2xl text-mist">
          tiyuvta <span className="italic text-mist-dim">crm</span>
        </h1>
        <button type="button" onClick={refresh} className="cursor-pointer font-mono text-[11px] text-mist-faint underline">
          refresh
        </button>
        {pipeline && (
          <span className="ml-auto font-mono text-[10px] text-mist-faint">{pipeline.updatedAt.slice(11, 16)}Z</span>
        )}
      </header>

      {error && <div className="mb-3 rounded-lg border border-coral/40 px-3 py-2 font-mono text-xs text-coral">{error}</div>}

      {/* tab bar — one screen per question: work the pipeline, read the money,
          read the growth, check the serving */}
      <div className="mb-3 flex gap-1 border-b border-white/8">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => goTab(t)}
            className={`cursor-pointer border-b-2 px-3 py-2 font-mono text-[12px] transition-colors ${
              tab === t ? 'border-amber text-mist' : 'border-transparent text-mist-faint hover:text-mist-dim'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab !== 'pipeline' && !overview && !error && (
        <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">loading…</div>
      )}
      {tab === 'money' && overview && <MoneyTab data={overview} />}
      {tab === 'growth' && overview && <GrowthTab data={overview} />}
      {tab === 'health' && overview && <HealthTab data={overview} />}

      {tab === 'pipeline' && (
        <>
      {overview && (
        <div className="mb-3">
          <PulseStrip data={overview} dueCount={due.length} />
        </div>
      )}

      {/* kind row — which job am I doing right now */}
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        <button type="button" onClick={() => setKind('all')} className={chipClass(kind === 'all')}>
          all {items.length}
        </button>
        {(['direction', 'lead', 'account'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(kind === k ? 'all' : k)}
            className={chipClass(kind === k, kind === k ? '' : KIND_TONE[k])}
          >
            {KIND_LABEL[k]} {kindCounts.get(k) ?? 0}
          </button>
        ))}
        {due.length > 0 && (
          <button
            type="button"
            onClick={() => setStage(stage === 'due' ? 'any' : 'due')}
            className={chipClass(stage === 'due', 'text-amber')}
          >
            ⏰ due {due.length}
          </button>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search"
          className="ml-auto w-28 min-w-0 shrink rounded-full border border-white/10 bg-ink px-3 py-1.5 font-mono text-[11px] text-mist placeholder:text-mist-faint focus:w-44 focus:outline-none sm:w-40"
        />
      </div>

      {/* stage row — the funnel cut for the phone list; the board already
          shows every stage as a column, so this row hides on desktop */}
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1 lg:hidden">
        <button type="button" onClick={() => setStage('any')} className={chipClass(stage === 'any')}>
          any stage
        </button>
        {CRM_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStage(stage === s ? 'any' : s)}
            className={chipClass(stage === s)}
          >
            {STAGE_LABEL[s]} {stageCounts.get(s) ?? 0}
          </button>
        ))}
      </div>

      {/* desktop: kanban board over the kind/search-filtered items (stage
          filter does not apply — every stage is its own column) */}
      <div className="hidden lg:block">
        <Board
          items={stage === 'due' ? visible : inKind.filter((i) => !needle || matches(i, needle))}
          onOpen={setOpenId}
        />
      </div>

      {/* phone: flat list, due-first sort from the server */}
      <div className="space-y-1.5 lg:hidden">
        {visible.map((item) => (
          <ItemCard key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
        ))}
        {pipeline && visible.length === 0 && (
          <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
            nothing here
          </div>
        )}
      </div>
      {!pipeline && !error && (
        <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
          loading…
        </div>
      )}
        </>
      )}

      {open && <Detail item={open} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  );
}
