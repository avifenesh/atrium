// Standalone CRM — the one atrium surface that leaves the machine (crm host via
// Cloudflare tunnel + Access; also served at /crm.html on loopback/tailnet).
//
// Deliberately self-contained: it talks ONLY to /api/crm/* — the snapshot, the
// SSE stream and every other atrium API are blocked on the public host, so this
// page must not want them. Phone-first: one column, thumb-sized targets, the
// due-follow-ups on top.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CrmItem, CrmPipeline, CrmStage } from '../../../shared/types';
import { CRM_STAGES, STAGE_LABEL, STAGE_TONE } from './stages';

const POLL_MS = 60_000;

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
        <span>{item.kind}</span>
        {item.subtitle && <span className="min-w-0 truncate">{item.subtitle}</span>}
        {item.followUpAt && (
          <span className={`ml-auto shrink-0 ${item.followUpDue ? 'text-amber' : ''}`}>
            ⏰ {relDay(item.followUpAt)}
          </span>
        )}
      </div>
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
              {item.kind}
              {item.subtitle && ` · ${item.subtitle}`}
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

type Filter = 'due' | 'all' | CrmStage;

export function CrmApp() {
  const [pipeline, setPipeline] = useState<CrmPipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPipeline(await api<CrmPipeline>('/api/crm/pipeline'));
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
  const counts = useMemo(() => {
    const map = new Map<CrmStage, number>();
    for (const item of items) map.set(item.stage, (map.get(item.stage) ?? 0) + 1);
    return map;
  }, [items]);
  const visible = filter === 'all' ? items : filter === 'due' ? due : items.filter((i) => i.stage === filter);
  const open = openId ? items.find((i) => i.id === openId) ?? null : null;

  return (
    <div className="mx-auto max-w-2xl px-3 pb-16 pt-4 sm:px-5">
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

      {/* filter chips — horizontal thumb scroll on phones */}
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {(['all', 'due', ...CRM_STAGES] as Filter[]).map((f) => {
          const count = f === 'all' ? items.length : f === 'due' ? due.length : counts.get(f) ?? 0;
          const active = filter === f;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
                active ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
              } ${f === 'due' && due.length > 0 ? 'text-amber' : ''}`}
            >
              {f === 'all' ? 'all' : f === 'due' ? 'due' : STAGE_LABEL[f as CrmStage]} {count}
            </button>
          );
        })}
      </div>

      {error && <div className="mb-3 rounded-lg border border-coral/40 px-3 py-2 font-mono text-xs text-coral">{error}</div>}

      <div className="space-y-1.5">
        {visible.map((item) => (
          <ItemCard key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
        ))}
        {pipeline && visible.length === 0 && (
          <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
            nothing here
          </div>
        )}
        {!pipeline && !error && (
          <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
            loading…
          </div>
        )}
      </div>

      {open && <Detail item={open} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  );
}
