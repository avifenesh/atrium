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
import type { CrmActivity, CrmItem, CrmOverview, CrmPipeline, CrmStage } from '../../../shared/types';
import { ActivityTab } from './Activity';
import { awaitingYou, DoLink, RelevanceBits } from './Action';
import { Board } from './Board';
import { ModelsTab } from './Models';
import { HealthTab, MoneyTab, OutreachTab, PulseStrip, TrafficTab } from './Overview';
import { SecurityTab } from './Security';
import { UsersTab } from './Users';
import { CRM_STAGES, PIPELINE_STAGES, STAGE_LABEL, STAGE_TONE, stageLabelFor } from './stages';

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

function StageBadge({ item, stage, overridden }: { item: Pick<CrmItem, 'kind' | 'source'>; stage: CrmStage; overridden: boolean }) {
  return (
    <span className={`shrink-0 rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] ${STAGE_TONE[stage]}`}>
      {stageLabelFor(item, stage)}
      {overridden && ' *'}
    </span>
  );
}

function ItemCard({ item, onOpen }: { item: CrmItem; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the card itself: Enter on the nested Do button must launch, not open.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="block w-full cursor-pointer rounded-xl border border-white/8 bg-ink-2 px-3.5 py-3 text-left transition-colors hover:border-white/20"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-mist">{item.title}</span>
        <StageBadge item={item} stage={item.stage} overridden={item.overridden} />
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-mist-faint">
        <span className={KIND_TONE[item.kind]}>{item.kind}</span>
        <RelevanceBits item={item} />
        {item.source && item.source !== 'seller' && <span>{item.source}</span>}
        {item.subtitle && <span className="min-w-0 truncate">{item.subtitle}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {item.activityAt && !item.followUpAt && <span>{age(item.activityAt)}</span>}
          {item.followUpAt && (
            <span className={item.followUpDue ? 'text-amber' : ''}>⏰ {relDay(item.followUpAt)}</span>
          )}
        </span>
      </div>
      <DoLink item={item} compact />
      {item.kind === 'direction' && item.detail && (
        <div className="mt-1.5 line-clamp-2 whitespace-pre-line text-xs text-mist-dim">{item.detail}</div>
      )}
    </div>
  );
}

/**
 * The admin actions board (owner ask 2026-08-31), for console accounts only.
 *
 * Seam rules it keeps, from the 2026-08-17 operator-UI ruling this supersedes
 * in part: every action is an ALLOWLIST name (never a path), the tenant is the
 * OPENED account (never a free-text id box), destructive actions take two taps
 * (the second labeled with what is about to happen), and grant is bounded
 * server-side ($50 board ceiling; bigger grants stay a documented curl).
 * Suspension goes through the console suspend endpoint, which revokes engine
 * keys with it: a direct D1 suspension without key revocation took the whole
 * API fail-closed for 65 minutes on 2026-08-31.
 */
function AdminActions({ item, busy, run }: { item: CrmItem; busy: boolean; run: (work: () => Promise<unknown>) => Promise<void> }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [grantUsd, setGrantUsd] = useState(5);
  if (item.kind !== 'account' || !item.metrics || !item.id.startsWith('tenant:')) return null;
  const m = item.metrics;
  const tenant = item.id.slice('tenant:'.length);
  const email = item.title.includes('@') ? item.title : null;

  const act = (name: string, extra?: Record<string, unknown>) =>
    run(() => post(`/api/crm/act/${name}`, { tenant, ...extra }));
  // Two taps: the first arms, the second (relabeled) fires; arming decays.
  const guarded = (name: string, extra?: Record<string, unknown>) => {
    if (confirm !== name) {
      setConfirm(name);
      window.setTimeout(() => setConfirm((c) => (c === name ? null : c)), 5000);
      return;
    }
    setConfirm(null);
    void act(name, extra);
  };

  const btn = (armed: boolean, tone: string) =>
    `cursor-pointer rounded-lg border px-2.5 py-1.5 font-mono text-[11px] ${
      armed ? 'border-coral/60 bg-coral/10 text-coral' : `border-white/8 ${tone}`
    }`;

  return (
    <div className="mt-4">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">admin</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {!m.suspended && (
          <button type="button" disabled={busy} onClick={() => guarded('suspend')} className={btn(confirm === 'suspend', 'text-coral')}>
            {confirm === 'suspend' ? 'really suspend (revokes keys)' : 'suspend'}
          </button>
        )}
        {m.suspended && (
          <button type="button" disabled={busy} onClick={() => guarded('restore')} className={btn(confirm === 'restore', 'text-jade')}>
            {confirm === 'restore' ? 'really restore' : 'restore'}
          </button>
        )}
        {!m.enrolled && (
          <button type="button" disabled={busy} onClick={() => guarded('enroll')} className={btn(confirm === 'enroll', 'text-mist-dim')}>
            {confirm === 'enroll' ? 'really enroll with the engine' : 'enroll'}
          </button>
        )}
        <span className="ml-1 inline-flex items-center gap-1">
          <select
            value={grantUsd}
            disabled={busy}
            onChange={(e) => {
              setGrantUsd(Number(e.target.value));
              setConfirm(null);
            }}
            className="rounded-lg border border-white/10 bg-ink px-1.5 py-1.5 font-mono text-[11px] text-mist"
          >
            {[5, 10, 25].map((v) => (
              <option key={v} value={v}>${v}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => guarded('grant', { amountMicro: grantUsd * 1_000_000, reason: 'crm-board' })}
            className={btn(confirm === 'grant', 'text-amber')}
          >
            {confirm === 'grant' ? `really grant $${grantUsd}` : 'grant credit'}
          </button>
        </span>
        {email && (
          <a
            href={`mailto:${email}`}
            className="cursor-pointer rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[11px] text-mist-dim no-underline"
          >
            mail
          </a>
        )}
      </div>
    </div>
  );
}

function ActionEditor({ item, busy, run }: { item: CrmItem; busy: boolean; run: (work: () => Promise<unknown>) => Promise<void> }) {
  const [label, setLabel] = useState(item.action?.label ?? '');
  const [brief, setBrief] = useState(item.action?.brief ?? '');
  const [href, setHref] = useState(item.action?.href ?? item.url ?? '');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    setLabel(item.action?.label ?? '');
    setBrief(item.action?.brief ?? '');
    setHref(item.action?.href ?? item.url ?? '');
  }, [item.id, item.url, item.action?.updatedAt, item.action?.label, item.action?.brief, item.action?.href]);

  return (
    <div className="mt-5 rounded-xl border border-amber/25 bg-amber/[0.04] p-4 sm:p-5">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-amber">do</div>
      <div className="space-y-3">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="do draft a mail to…"
          className="w-full rounded-lg border border-white/10 bg-ink px-3 py-2.5 font-mono text-sm text-mist placeholder:text-mist-faint"
        />
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="artifact, destination, opening sentence"
          rows={12}
          className="min-h-48 w-full resize-y rounded-lg border border-white/10 bg-ink px-3 py-3 text-sm leading-relaxed text-mist placeholder:text-mist-faint"
        />
        <input
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder={item.url ?? 'https://…'}
          className="w-full rounded-lg border border-white/10 bg-ink px-3 py-2.5 font-mono text-sm text-mist placeholder:text-mist-faint"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || !label.trim()}
            onClick={() =>
              run(() =>
                post('/api/crm/entry', {
                  id: item.id,
                  action: { label, brief: brief.trim() || null, href: href.trim() || null },
                }),
              )
            }
            className="cursor-pointer rounded-lg border border-white/15 px-3 py-2 font-mono text-[12px] text-mist disabled:opacity-40"
          >
            save
          </button>
          {item.action && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => post('/api/crm/entry', { id: item.id, action: null }))}
              className="cursor-pointer font-mono text-[12px] text-mist-faint underline"
            >
              clear
            </button>
          )}
          {item.action && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setCopyFailed(false);
                void api<{ prompt: string }>(`/api/crm/do-prompt?id=${encodeURIComponent(item.id)}`)
                  .then((body) => {
                    // Not a secure context (the page is also served over plain http on
                    // the tailnet) means no clipboard API at all.
                    if (!navigator.clipboard) throw new Error('no clipboard here');
                    return navigator.clipboard.writeText(body.prompt);
                  })
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  })
                  .catch(() => setCopyFailed(true));
              }}
              className="cursor-pointer font-mono text-[12px] text-mist-faint underline"
            >
              {copyFailed ? 'copy failed' : copied ? 'prompt copied' : 'copy prompt'}
            </button>
          )}
        </div>
        <DoLink item={item} />
      </div>
    </div>
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
        className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-white/10 bg-ink-2 p-5 sm:rounded-2xl sm:p-6"
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
          <div className="mt-3 whitespace-pre-line rounded-lg border border-white/8 px-3 py-2 text-sm text-mist-dim">
            {item.detail}
          </div>
        )}

        <ActionEditor item={item} busy={busy} run={run} />

        <AdminActions item={item} busy={busy} run={run} />

        {/* stage — one tap per column; tapping the derived stage clears the override */}
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">
            stage{item.overridden && ` (pinned — sources say ${stageLabelFor(item, item.derivedStage)})`}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {/* The full stage set here, deliberately: this drawer also opens accounts from the
                users screen, and an account really does sit in signed-up / active / paying. */}
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
                {stageLabelFor(item, stage)}
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
// One tab per question: work the pipeline, see what changed, read the users,
// count the models, read the money, see who visits, judge the outreach, check for
// fire, read the abuse shapes.
const TABS = ['pipeline', 'activity', 'users', 'models', 'money', 'traffic', 'outreach', 'health', 'security'] as const;
type Tab = (typeof TABS)[number];

/**
 * The hash carries the tab and the activity window: `#activity` is today + quiet,
 * `#activity/week` is seven days + quiet, `#activity/all` is seven days with
 * mechanical rows. Toggles ride the hash so refresh and back keep them.
 */
const readHash = (): { tab: Tab; feedAll: boolean; week: boolean } => {
  const [head, option] = window.location.hash.replace('#', '').split('/');
  // the old growth tab split into traffic + outreach
  const name = head === 'growth' ? 'traffic' : head;
  return {
    tab: (TABS as readonly string[]).includes(name) ? (name as Tab) : 'pipeline',
    feedAll: option === 'all',
    week: option === 'week' || option === 'all',
  };
};
const writeHash = (tab: Tab, feedAll: boolean, week: boolean): string => {
  if (tab !== 'activity') return tab === 'pipeline' ? '' : tab;
  if (feedAll) return 'activity/all';
  if (week) return 'activity/week';
  return 'activity';
};

function rankWorkQueue(rows: CrmItem[]): CrmItem[] {
  return [...rows].sort((a, b) => {
    const aReady = awaitingYou(a) ? 0 : 1;
    const bReady = awaitingYou(b) ? 0 : 1;
    if (aReady !== bReady) return aReady - bReady;
    const byScore = (b.relevance?.score ?? 0) - (a.relevance?.score ?? 0);
    if (byScore !== 0) return byScore;
    return (b.activityAt ?? '').localeCompare(a.activityAt ?? '');
  });
}

const matches = (i: CrmItem, needle: string) =>
  `${i.title} ${i.subtitle ?? ''} ${i.source ?? ''} ${i.detail ?? ''} ${i.action?.label ?? ''} ${i.action?.brief ?? ''}`
    .toLowerCase()
    .includes(needle);

// A skipped or lost row is a decision already made. Showing it forever means the list grows
// without the work growing, and it buried the rows that still need a reply.
const CLOSED = new Set<CrmStage>(['lost', 'skipped']);

/** The board's one-line motion chip: the four shapes worth a tap from the board.
 *  Spend replaced near-miss here because the chip counts signal rows and a near
 *  miss is a diagnostic to rescue on the activity tab, not motion in the funnel. */
const TODAY_CHIP_LABEL = {
  'account-new': 'signup',
  'lead-new': 'lead',
  'account-usage': 'spend',
  'stage-change': 'move',
} as const;

const chipClass = (active: boolean, extra = '') =>
  `shrink-0 cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[11px] ${
    active ? 'border-white/25 bg-white/5 text-mist' : 'border-white/8 text-mist-dim'
  } ${extra}`;

export function CrmApp() {
  const [pipeline, setPipeline] = useState<CrmPipeline | null>(null);
  const [overview, setOverview] = useState<CrmOverview | null>(null);
  const [activity, setActivity] = useState<CrmActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('lead');
  const [stage, setStage] = useState<StageFilter>('any');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [onlyQualified, setOnlyQualified] = useState(true);
  const [awaitingOnly, setAwaitingOnly] = useState(false);
  const [tab, setTab] = useState<Tab>(() => readHash().tab);
  const [feedAll, setFeedAll] = useState(() => readHash().feedAll);
  const [feedWeek, setFeedWeek] = useState(() => readHash().week);

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      setTab(next.tab);
      setFeedAll(next.feedAll);
      setFeedWeek(next.week);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const goTab = (next: Tab) => {
    window.location.hash = writeHash(next, feedAll, feedWeek);
    setTab(next);
  };
  const goFeedAll = (next: boolean) => {
    window.location.hash = writeHash('activity', next, next || feedWeek);
    setFeedAll(next);
    if (next) setFeedWeek(true);
  };
  const goFeedWeek = (next: boolean) => {
    window.location.hash = writeHash('activity', next ? feedAll : false, next);
    setFeedWeek(next);
    if (!next) setFeedAll(false);
  };

  const refresh = useCallback(async () => {
    try {
      const [nextPipeline, nextOverview, nextActivity] = await Promise.all([
        api<CrmPipeline>('/api/crm/pipeline'),
        api<CrmOverview>('/api/crm/overview'),
        api<CrmActivity>('/api/crm/activity'),
      ]);
      setPipeline(nextPipeline);
      setOverview(nextOverview);
      setActivity(nextActivity);
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

  const allItems = pipeline?.items ?? [];
  // The pipeline is for things you chase through stages. An account is a customer whose numbers you
  // read, and it has its own screen now, so it is not a pipeline card. Keeping both here forced one
  // list to answer two unrelated questions.
  const workable = useMemo(() => allItems.filter((i) => i.kind !== 'account'), [allItems]);
  const items = useMemo(
    () => (showClosed ? workable : workable.filter((i) => !CLOSED.has(i.stage))),
    [workable, showClosed],
  );
  const closedCount = useMemo(() => workable.filter((i) => CLOSED.has(i.stage)).length, [workable]);
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
  // The chips (search, qualified, needs research) apply to BOTH layouts. The kanban
  // board keeps every stage — that is its axis — so it takes this list, not `visible`:
  // filtering the phone list only made the desktop chips look active and do nothing.
  const chipFiltered = useMemo(
    () => inKind.filter((i) => {
      if (onlyQualified && i.kind === 'lead' && i.relevance && !i.relevance.qualified) return false;
      if (awaitingOnly && !awaitingYou(i)) return false;
      return !needle || matches(i, needle);
    }),
    [inKind, onlyQualified, awaitingOnly, needle],
  );
  const ranked = useMemo(() => rankWorkQueue(chipFiltered), [chipFiltered]);
  const visible = useMemo(() => {
    const rows = ranked.filter((i) => {
      if (stage === 'due') return i.followUpDue;
      return stage === 'any' || i.stage === stage;
    });
    return rows;
  }, [ranked, stage]);
  const nextSend = useMemo(
    () => (kind === 'lead' && stage === 'any' ? ranked.filter((i) => awaitingYou(i)).slice(0, 3) : []),
    [kind, stage, ranked],
  );
  const qualifiedCount = useMemo(
    () => inKind.filter((i) => i.kind === 'lead' && (i.relevance?.qualified ?? false)).length,
    [inKind],
  );
  const awaitingCount = useMemo(() => inKind.filter((i) => awaitingYou(i)).length, [inKind]);
  // Resolve against allItems, not the pipeline-narrowed list: the users screen opens accounts,
  // which `items` deliberately excludes.
  const open = openId ? allItems.find((i) => i.id === openId) ?? null : null;

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
          read the growth, check the serving, read the abuse shapes.
          It scrolls: nine 12px monospace labels are wider than a phone. */}
      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-white/8">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => goTab(t)}
            className={`shrink-0 cursor-pointer border-b-2 px-3 py-2 font-mono text-[12px] transition-colors ${
              tab === t ? 'border-amber text-mist' : 'border-transparent text-mist-faint hover:text-mist-dim'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab !== 'pipeline' && tab !== 'users' && tab !== 'activity' && !overview && !error && (
        <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">loading…</div>
      )}
      {tab === 'users' && (
        pipeline
          ? <UsersTab items={allItems} onOpen={setOpenId} />
          : !error && (
            <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">loading…</div>
          )
      )}
      {tab === 'activity' && (
        activity
          ? (
            <ActivityTab
              activity={activity}
              showAll={feedAll}
              week={feedWeek}
              onShowAll={goFeedAll}
              onShowWeek={goFeedWeek}
              onOpen={setOpenId}
            />
          )
          : !error && (
            <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">loading…</div>
          )
      )}
      {tab === 'money' && overview && <MoneyTab data={overview} />}
      {tab === 'models' && overview && <ModelsTab data={overview} />}
      {tab === 'traffic' && overview && <TrafficTab data={overview} />}
      {tab === 'outreach' && overview && <OutreachTab data={overview} />}
      {tab === 'health' && overview && <HealthTab data={overview} />}
      {/* The security page needs both feeds: the posture comes from the overview,
          the suspended rows and the drawer come from the pipeline. */}
      {tab === 'security' && overview && <SecurityTab data={overview} items={allItems} onOpen={setOpenId} />}

      {tab === 'pipeline' && (
        <>
      {overview && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <PulseStrip data={overview} dueCount={due.length} />
          {/* Today's motion, one tap from the board (the feed itself is the activity
              tab). It counts todaySignal, not today: this chip and the feed it links
              to have to agree, and the feed hides the mechanical rows. */}
          {activity && Object.values(activity.todaySignal ?? activity.today).some((n) => (n ?? 0) > 0) && (
            <button
              type="button"
              onClick={() => goTab('activity')}
              className="cursor-pointer rounded-full border border-slate-glow/40 px-2.5 py-1 font-mono text-[10px] text-slate-glow"
            >
              today: {(['account-new', 'lead-new', 'account-usage', 'stage-change'] as const)
                .filter((t) => ((activity.todaySignal ?? activity.today)[t] ?? 0) > 0)
                .map((t) => `${(activity.todaySignal ?? activity.today)[t]} ${TODAY_CHIP_LABEL[t]}`)
                .join(' · ') || 'activity'} →
            </button>
          )}
        </div>
      )}

      {/* kind row — which job am I doing right now */}
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        <button type="button" onClick={() => setKind('all')} className={chipClass(kind === 'all')}>
          all {items.length}
        </button>
        {(['direction', 'lead'] as const).map((k) => (
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
        {/* Default on: the board is the work queue, not the firehose. Score-0
            rows never reach the pipeline; this chip hides the remaining
            unqualified (1–4) ones. Click off to see weak-signal leftovers. */}
        <button
          type="button"
          onClick={() => setOnlyQualified(!onlyQualified)}
          className={chipClass(onlyQualified, onlyQualified ? '' : 'text-jade')}
        >
          ◆ qualified {qualifiedCount}
        </button>
        <button
          type="button"
          onClick={() => setAwaitingOnly(!awaitingOnly)}
          className={chipClass(awaitingOnly, awaitingOnly ? '' : 'text-amber')}
        >
          awaiting you {awaitingCount}
        </button>
        {closedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowClosed(!showClosed)}
            className={chipClass(showClosed, 'text-mist-faint')}
          >
            closed {closedCount}
          </button>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search"
          className="ml-auto w-28 min-w-0 shrink rounded-full border border-white/10 bg-ink px-3 py-1.5 font-mono text-[11px] text-mist placeholder:text-mist-faint focus:w-44 focus:outline-none sm:w-40"
        />
      </div>

      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1 lg:hidden">
        <button type="button" onClick={() => setStage('any')} className={chipClass(stage === 'any')}>
          any stage
        </button>
        {PIPELINE_STAGES.map((s) => (
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

      {nextSend.length > 0 && (
        <div className="mb-3 hidden rounded-xl border border-amber/25 bg-amber/[0.04] px-3 py-2.5 lg:block">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-amber">send next</div>
          <div className="space-y-1.5">
            {nextSend.map((item) => (
              <ItemCard key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
            ))}
          </div>
        </div>
      )}

      <div className="hidden lg:block">
        <Board
          items={stage === 'due' ? visible : ranked}
          onOpen={setOpenId}
          onMove={(id, nextStage) => {
            void post('/api/crm/entry', { id, stage: nextStage })
              .then(refresh)
              .catch((err) => setError(err instanceof Error ? err.message : String(err)));
          }}
        />
      </div>

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
