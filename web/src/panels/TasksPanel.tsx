import { useState, type CSSProperties, type ReactNode } from 'react';
import { clearAllNotifications, clearNotification, isMuted } from '../api';
import { Dot, EmptyState, MuteButton, Panel, QuietChip, RelTime, Row, SectionLabel, SendToEigen } from '../components/ui';
import type { EigenDispatch, GithubItem, GithubNotification, GithubPR, OrgItem, Snapshot } from '../../../shared/types';

function ciStatus(ci: GithubPR['ci']): string {
  if (ci === 'SUCCESS') return 'running'; // jade
  if (ci === 'FAILURE' || ci === 'ERROR') return 'error'; // coral
  if (ci === null) return 'unknown'; // mist-faint
  return 'active'; // PENDING / EXPECTED — amber
}

const DECISION: Record<NonNullable<GithubPR['reviewDecision']>, { label: string; cls: string }> = {
  APPROVED: { label: 'approved', cls: 'text-jade' },
  CHANGES_REQUESTED: { label: 'changes', cls: 'text-coral' },
  REVIEW_REQUIRED: { label: 'review', cls: 'text-amber' },
};

function Chip({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <span className={`shrink-0 whitespace-nowrap rounded border hairline px-1.5 py-px font-mono text-[10px] ${className}`}>
      {children}
    </span>
  );
}

/** Hover-cluster external link to the real github page — the row itself opens the
 *  in-app slide-over; this is the explicit "take me to the site" door. */
function GithubLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="open on github"
      className="hover-cluster shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-slate-glow"
    >
      github
    </a>
  );
}

/** Parse owner/repo + number out of a github issues/pull html url. */
function parseItemUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  if (!m) return null;
  return { repo: m[1], number: Number(m[2]) };
}

/** Hover cluster tail: quiet THIS line first, then fainter repo / org variants. */
function RepoMutes({ repo, itemId }: { repo: string; itemId?: string }) {
  const owner = repo.includes('/') ? repo.slice(0, repo.indexOf('/')) : repo;
  return (
    <>
      {itemId && <MuteButton kind="github-item" target={itemId} />}
      <MuteButton kind="github-repo" target={repo} label="repo" className={itemId ? 'opacity-60' : ''} />
      <MuteButton kind="github-org" target={owner} label="org" className="opacity-60" />
    </>
  );
}

function notMuted(snapshot: Snapshot) {
  // github-item cascades through repo and org mutes inside isMuted
  return (x: { repo: string; id?: string }) =>
    x.id ? !isMuted(snapshot, 'github-item', x.id) : !isMuted(snapshot, 'github-repo', x.repo);
}

function ItemRow({
  item,
  dispatches,
  onOpenItem,
  accent = false,
}: {
  item: GithubItem;
  dispatches: EigenDispatch[];
  onOpenItem: (repo: string, number: number) => void;
  accent?: boolean;
}) {
  return (
    <Row onClick={() => onOpenItem(item.repo, item.number)} title={item.title}>
      {accent && <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />}
      <span className="w-36 shrink-0 truncate font-mono text-xs text-mist-faint xl:w-44">{item.repo}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{item.title}</span>
      <RelTime iso={item.updatedAt} />
      <span className="flex shrink-0 items-center gap-1">
        <GithubLink href={item.url} />
        <SendToEigen title={item.title} url={item.url} repo={item.repo} sourceId={item.id} dispatches={dispatches} />
        <RepoMutes repo={item.repo} itemId={item.id} />
      </span>
    </Row>
  );
}

function PRRow({
  pr,
  dispatches,
  onOpenItem,
}: {
  pr: GithubPR;
  dispatches: EigenDispatch[];
  onOpenItem: (repo: string, number: number) => void;
}) {
  const decision = pr.reviewDecision ? DECISION[pr.reviewDecision] : null;
  return (
    <Row onClick={() => onOpenItem(pr.repo, pr.number)} title={pr.title}>
      <Dot status={ciStatus(pr.ci)} />
      <span className="w-36 shrink-0 truncate font-mono text-xs text-mist-faint xl:w-44">{pr.repo}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{pr.title}</span>
      {pr.isDraft && <Chip className="text-mist-faint">draft</Chip>}
      {decision && <Chip className={decision.cls}>{decision.label}</Chip>}
      <RelTime iso={pr.updatedAt} />
      <span className="flex shrink-0 items-center gap-1">
        <GithubLink href={pr.url} />
        <SendToEigen title={pr.title} url={pr.url} repo={pr.repo} sourceId={pr.id} dispatches={dispatches} />
        <RepoMutes repo={pr.repo} itemId={pr.id} />
      </span>
    </Row>
  );
}

/** An external issue/PR on a repo he owns/admins — someone is blocked on him. Top
 *  priority; review-lane rows carry the amber hairline. Mirrors PRRow's draft/decision
 *  chips + ci Dot for PRs, plus a scope chip and the author in the hover cluster. */
function OrgRow({
  item,
  dispatches,
  onOpenItem,
}: {
  item: OrgItem;
  dispatches: EigenDispatch[];
  onOpenItem: (repo: string, number: number) => void;
}) {
  const isPR = item.kind === 'pr';
  const decision = isPR && item.reviewDecision ? DECISION[item.reviewDecision] : null;
  const accent = item.lane === 'review';
  return (
    <Row onClick={() => onOpenItem(item.repo, item.number)} title={item.title}>
      {accent && <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />}
      {isPR && <Dot status={ciStatus(item.ci)} />}
      <Chip className="text-mist-faint">{item.scope}</Chip>
      <span className="w-32 shrink-0 truncate font-mono text-xs text-mist-faint xl:w-40">{item.repo}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{item.title}</span>
      {isPR && item.isDraft && <Chip className="text-mist-faint">draft</Chip>}
      {decision && <Chip className={decision.cls}>{decision.label}</Chip>}
      <RelTime iso={item.updatedAt} />
      <span className="flex shrink-0 items-center gap-1">
        {/* fixed slot: the cluster reserves space while hidden, so a variable-width
            author would push each row's RelTime left by a different amount */}
        <span className="hover-cluster w-24 shrink-0 truncate text-right font-mono text-[11px] text-mist-faint">
          @{item.author}
        </span>
        <GithubLink href={item.url} />
        <SendToEigen title={item.title} url={item.url} repo={item.repo} sourceId={item.id} dispatches={dispatches} />
        <RepoMutes repo={item.repo} itemId={item.id} />
      </span>
    </Row>
  );
}

function NotificationRow({
  n,
  dispatches,
  onClear,
  onOpenItem,
}: {
  n: GithubNotification;
  dispatches: EigenDispatch[];
  onClear: (id: string) => void;
  onOpenItem: (repo: string, number: number) => void;
}) {
  // subject is an issue/PR -> open the slide-over; otherwise the row is a plain
  // external link (commit/release/discussion notifications etc.)
  const item = parseItemUrl(n.url);
  const rowProps = item ? { onClick: () => onOpenItem(item.repo, item.number) } : { href: n.url };
  return (
    <Row {...rowProps} title={n.title}>
      <Chip className="text-mist-dim">{n.reason}</Chip>
      <span className="w-32 shrink-0 truncate font-mono text-xs text-mist-faint xl:w-40">{n.repo}</span>
      <span className={`min-w-0 flex-1 truncate text-sm ${n.unread ? 'text-mist' : 'text-mist-dim'}`}>{n.title}</span>
      <RelTime iso={n.updatedAt} />
      <span className="flex shrink-0 items-center gap-1">
        {item && <GithubLink href={n.url} />}
        <SendToEigen title={n.title} url={n.url} repo={n.repo} sourceId={n.id} dispatches={dispatches} />
        <button
          type="button"
          title="mark this notification read"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClear(n.id);
          }}
          className="hover-cluster shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-amber"
        >
          clear
        </button>
        <MuteButton kind="github-reason" target={n.reason} className="opacity-60" />
        <RepoMutes repo={n.repo} />
      </span>
    </Row>
  );
}

export default function TasksPanel({
  snapshot,
  onOpenQuiet,
  onOpenItem,
}: {
  snapshot: Snapshot;
  onOpenQuiet?: () => void;
  onOpenItem: (repo: string, number: number) => void;
}) {
  const g = snapshot.github;
  const dispatches = snapshot.agents.dispatches;
  const [teamOpen, setTeamOpen] = useState(false);
  // optimistic clear — removed ids vanish immediately, restored if the API call fails
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [clearAllArmed, setClearAllArmed] = useState(false);

  const visible = notMuted(snapshot);
  // people blocked on him — review lane (external PRs awaiting his review) ranks above triage
  const orgQueue = g.orgQueue.filter(visible);
  const orgReview = orgQueue.filter((it) => it.lane === 'review');
  const orgTriage = orgQueue.filter((it) => it.lane === 'triage');
  // orgQueue outranks actNow — if an item is in both (external PR where I'm also a
  // requested reviewer), show it only in the higher lane
  const orgIds = new Set(g.orgQueue.map((it) => it.id));
  const actNow = g.actNow.filter((it) => visible(it) && !orgIds.has(it.id));
  const myPRs = g.myPRs.filter(visible);
  const mentions = g.mentions.filter(visible);
  const teamQueue = g.teamQueue.filter(visible);
  const notifAll = g.notifications.filter((n) => !cleared.has(n.id));
  // notification ids are thread ids, not owner/repo#N — check repo mutes only
  const notifications = notifAll.filter(
    (n) => visible({ repo: n.repo }) && !isMuted(snapshot, 'github-reason', n.reason),
  );
  const ownRepos = g.ownRepos.filter(visible);

  const clearOne = (id: string) => {
    setCleared((s) => new Set(s).add(id));
    clearNotification(id).catch(() => {
      setCleared((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    });
  };

  const clearAll = () => {
    if (!clearAllArmed) {
      setClearAllArmed(true);
      setTimeout(() => setClearAllArmed(false), 4000);
      return;
    }
    setClearAllArmed(false);
    const prev = cleared;
    setCleared(new Set(g.notifications.map((n) => n.id)));
    clearAllNotifications().catch(() => setCleared(prev));
  };

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3 px-1">
        <h1 className="text-sm font-semibold lowercase tracking-wide text-mist">tasks</h1>
        <div className="flex min-w-0 items-baseline gap-4 font-mono text-xs text-mist-dim">
          {g.error && (
            <span className="max-w-96 truncate text-coral" title={g.error}>
              {g.error}
            </span>
          )}
          {g.rateLimit && (
            <span className="tabular-nums" title="github rate limit">
              {g.rateLimit.remaining}/{g.rateLimit.limit}
            </span>
          )}
          <RelTime iso={g.updatedAt} />
        </div>
      </header>

      <div className="grid grid-cols-12 gap-5">
        <Panel
          title="waiting on you"
          riseIndex={0}
          className="col-span-12"
          quietCount={g.orgQueue.length - orgQueue.length}
          onQuietClick={onOpenQuiet}
          right={
            orgQueue.length > 0 ? (
              // amber only while the review lane has items — a triage-only queue stays plain
              <span
                className={`font-mono text-xs tabular-nums ${orgReview.length > 0 ? 'text-amber' : 'text-mist-faint'}`}
              >
                {orgQueue.length}
              </span>
            ) : undefined
          }
        >
          {orgQueue.length === 0 ? (
            <EmptyState>nobody waiting</EmptyState>
          ) : (
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {orgReview.length > 0 && (
                <>
                  <SectionLabel>
                    review <span className="tabular-nums text-amber">· {orgReview.length}</span>
                  </SectionLabel>
                  {orgReview.map((it) => (
                    <OrgRow key={it.id} item={it} dispatches={dispatches} onOpenItem={onOpenItem} />
                  ))}
                </>
              )}
              {orgTriage.length > 0 && (
                <>
                  <SectionLabel>
                    triage <span className="tabular-nums">· {orgTriage.length}</span>
                  </SectionLabel>
                  {orgTriage.map((it) => (
                    <OrgRow key={it.id} item={it} dispatches={dispatches} onOpenItem={onOpenItem} />
                  ))}
                </>
              )}
            </div>
          )}
        </Panel>

        <Panel
          title="act now"
          riseIndex={1}
          className="col-span-12"
          quietCount={g.actNow.length - actNow.length}
          onQuietClick={onOpenQuiet}
          right={
            actNow.length > 0 ? (
              <span className="font-mono text-xs tabular-nums text-amber">{actNow.length}</span>
            ) : undefined
          }
        >
          {actNow.length === 0 ? (
            <EmptyState>nothing urgent</EmptyState>
          ) : (
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {actNow.map((it) => (
                <ItemRow key={it.id} item={it} dispatches={dispatches} onOpenItem={onOpenItem} accent />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="my open prs"
          riseIndex={2}
          className="col-span-12 lg:col-span-7"
          quietCount={g.myPRs.length - myPRs.length}
          onQuietClick={onOpenQuiet}
          right={
            myPRs.length > 0 ? (
              <span className="font-mono text-xs tabular-nums text-mist-faint">{myPRs.length}</span>
            ) : undefined
          }
        >
          {myPRs.length === 0 ? (
            <EmptyState>no open prs</EmptyState>
          ) : (
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {myPRs.map((pr) => (
                <PRRow key={pr.id} pr={pr} dispatches={dispatches} onOpenItem={onOpenItem} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="mentions"
          riseIndex={3}
          className="col-span-12 lg:col-span-5"
          quietCount={g.mentions.length - mentions.length}
          onQuietClick={onOpenQuiet}
          right={
            mentions.length > 0 ? (
              <span className="font-mono text-xs tabular-nums text-mist-faint">{mentions.length}</span>
            ) : undefined
          }
        >
          {mentions.length === 0 ? (
            <EmptyState>no mentions</EmptyState>
          ) : (
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {mentions.map((it) => (
                <ItemRow key={it.id} item={it} dispatches={dispatches} onOpenItem={onOpenItem} />
              ))}
            </div>
          )}
        </Panel>

        <section className="glass rise col-span-12 p-4 xl:p-5" style={{ '--rise-i': 4 } as CSSProperties}>
          <header className="flex items-baseline justify-between gap-3">
            <button
              type="button"
              onClick={() => setTeamOpen((o) => !o)}
              className="flex min-w-0 cursor-pointer items-baseline gap-2 text-left"
            >
              <span className="font-mono text-[11px] text-mist-faint">{teamOpen ? '▾' : '▸'}</span>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">team queue</h2>
              <span className="font-mono text-xs tabular-nums text-mist-dim">{teamQueue.length}</span>
            </button>
            {g.teamQueue.length - teamQueue.length > 0 && (
              <QuietChip count={g.teamQueue.length - teamQueue.length} onClick={onOpenQuiet} />
            )}
          </header>
          {teamOpen && (
            <div className="mt-3 max-h-80 space-y-0.5 overflow-y-auto">
              {teamQueue.length === 0 ? (
                <EmptyState>queue empty</EmptyState>
              ) : (
                teamQueue.map((pr) => <PRRow key={pr.id} pr={pr} dispatches={dispatches} onOpenItem={onOpenItem} />)
              )}
            </div>
          )}
        </section>

        <Panel
          title="notifications"
          riseIndex={5}
          className="col-span-12"
          quietCount={notifAll.length - notifications.length}
          onQuietClick={onOpenQuiet}
          right={
            notifications.length > 0 ? (
              <>
                <span className="font-mono text-xs tabular-nums text-mist-faint">{notifications.length}</span>
                <button
                  type="button"
                  onClick={clearAll}
                  title="mark all notifications read"
                  className={`cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                    clearAllArmed ? 'text-coral hover:text-coral' : 'text-mist-faint hover:text-amber'
                  }`}
                >
                  {clearAllArmed ? 'sure?' : 'clear all'}
                </button>
              </>
            ) : undefined
          }
        >
          {notifications.length === 0 ? (
            <EmptyState>no notifications</EmptyState>
          ) : (
            <div className="max-h-96 space-y-0.5 overflow-y-auto">
              {notifications.map((n) => (
                <NotificationRow key={n.id} n={n} dispatches={dispatches} onClear={clearOne} onOpenItem={onOpenItem} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="my repos"
          riseIndex={6}
          className="col-span-12"
          quietCount={g.ownRepos.length - ownRepos.length}
          onQuietClick={onOpenQuiet}
          right={
            ownRepos.length > 0 ? (
              <span className="font-mono text-xs tabular-nums text-mist-faint">{ownRepos.length}</span>
            ) : undefined
          }
        >
          {ownRepos.length === 0 ? (
            <EmptyState>no repos</EmptyState>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-3 2xl:grid-cols-4">
              {ownRepos.map((r) => (
                <Row key={r.repo} href={`https://github.com/${r.repo}`} title={r.repo} className="border hairline">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-mist">{r.repo}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-mist-dim">
                    {r.openIssues}
                    <span className="text-mist-faint"> iss </span>
                    {r.openPRs}
                    <span className="text-mist-faint"> pr</span>
                  </span>
                  <span className="flex shrink-0 items-center">
                    <RepoMutes repo={r.repo} />
                  </span>
                </Row>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
