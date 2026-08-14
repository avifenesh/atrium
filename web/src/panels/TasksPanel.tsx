import { useState, type CSSProperties, type ReactNode } from 'react';
import { clearAllNotifications, clearNotification, isMuted } from '../api';
import { Dot, EmptyState, MuteButton, Panel, QuietChip, RelTime, Row, SectionLabel, SendToEigen } from '../components/ui';
import type { EigenDispatch, GithubItem, GithubNotification, GithubPR, OrgItem, RepoInfo, ReposState, Snapshot } from '../../../shared/types';

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

function activityLabel(n: GithubNotification): string | null {
  if (!n.latestActivity) return null;
  if (n.noise?.kind === 'review-bot') return n.latestActivity.kind === 'review_comment' ? 'bot inline' : 'bot review';
  if (n.latestActivity.kind === 'review_comment') return 'review note';
  if (n.latestActivity.kind === 'review') return n.latestActivity.state?.toLowerCase() ?? 'review';
  return n.latestActivity.kind;
}

/** Hover cluster tail: quiet THIS line first, then fainter repo / org variants. */
function RepoMutes({ repo, itemId }: { repo: string; itemId?: string }) {
  const owner = repo.includes('/') ? repo.slice(0, repo.indexOf('/')) : repo;
  return (
    <>
      {itemId && <MuteButton kind="github-item" target={itemId} untilActivity />}
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
    <Row onClick={() => onOpenItem(item.repo, item.number)} title={item.title} className="flex-wrap sm:flex-nowrap">
      {accent && <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />}
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{item.title}</span>
      <span className="hidden max-w-[10rem] shrink-0 truncate font-mono text-xs text-mist-faint sm:inline 2xl:max-w-[12rem]" title={item.repo}>
        {item.repo}
      </span>
      <RelTime iso={item.updatedAt} />
      <span className="row-actions mobile-row-actions ml-auto shrink-0 justify-end sm:ml-0 sm:basis-auto">
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
    <Row onClick={() => onOpenItem(pr.repo, pr.number)} title={pr.title} className="flex-wrap sm:flex-nowrap">
      <Dot status={ciStatus(pr.ci)} />
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{pr.title}</span>
      <span className="hidden max-w-[10rem] shrink-0 truncate font-mono text-xs text-mist-faint sm:inline 2xl:max-w-[12rem]" title={pr.repo}>
        {pr.repo}
      </span>
      {pr.isDraft && <Chip className="hidden text-mist-faint sm:inline-flex">draft</Chip>}
      {decision && <Chip className={`hidden sm:inline-flex ${decision.cls}`}>{decision.label}</Chip>}
      <RelTime iso={pr.updatedAt} />
      <span className="row-actions mobile-row-actions ml-auto shrink-0 justify-end sm:ml-0 sm:basis-auto">
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
    <Row onClick={() => onOpenItem(item.repo, item.number)} title={item.title} className="flex-wrap sm:flex-nowrap">
      {accent && <span className="h-4 w-0.5 shrink-0 rounded-full bg-amber/80" />}
      {isPR && <Dot status={ciStatus(item.ci)} />}
      <Chip className="hidden text-mist-faint sm:inline-flex">{item.scope}</Chip>
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{item.title}</span>
      <span className="hidden max-w-[9rem] shrink-0 truncate font-mono text-xs text-mist-faint sm:inline xl:max-w-[11rem]" title={item.repo}>
        {item.repo}
      </span>
      {isPR && item.isDraft && <Chip className="hidden text-mist-faint sm:inline-flex">draft</Chip>}
      {decision && <Chip className={`hidden sm:inline-flex ${decision.cls}`}>{decision.label}</Chip>}
      <RelTime iso={item.updatedAt} />
      <span className="row-actions mobile-row-actions ml-auto shrink-0 justify-end sm:ml-0 sm:basis-auto">
        {/* fixed slot: the cluster reserves space while hidden, so a variable-width
            author would push each row's RelTime left by a different amount */}
        <span className="hover-cluster hidden w-24 shrink-0 truncate text-right font-mono text-[11px] text-mist-faint 2xl:block">
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
    <Row {...rowProps} title={n.title} className="flex-wrap sm:flex-nowrap">
      <Chip className="hidden text-mist-dim sm:inline-flex">{n.reason}</Chip>
      <span className={`min-w-0 flex-1 truncate text-sm ${n.unread ? 'text-mist' : 'text-mist-dim'}`}>{n.title}</span>
      <span className="hidden max-w-[9rem] shrink-0 truncate font-mono text-xs text-mist-faint sm:inline xl:max-w-[11rem]" title={n.repo}>
        {n.repo}
      </span>
      {activityLabel(n) && <Chip className={n.noise ? 'text-mist-dim' : 'text-mist-faint'}>{activityLabel(n)}</Chip>}
      {n.latestActivity && (
        <span
          className={`hidden w-32 shrink-0 truncate text-right font-mono text-[11px] ${n.noise ? 'text-mist-dim' : 'text-mist-faint'} xl:block`}
          title={`latest activity by ${n.latestActivity.actor}`}
        >
          @{n.latestActivity.actor}
        </span>
      )}
      <RelTime iso={n.updatedAt} />
      <span className="row-actions mobile-row-actions ml-auto shrink-0 justify-end sm:ml-0 sm:basis-auto">
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

function ReviewBotDigest({
  notifications,
  open,
  onToggle,
  dispatches,
  onClear,
  onOpenItem,
}: {
  notifications: GithubNotification[];
  open: boolean;
  onToggle: () => void;
  dispatches: EigenDispatch[];
  onClear: (id: string) => void;
  onOpenItem: (repo: string, number: number) => void;
}) {
  if (notifications.length === 0) return null;
  const latest = notifications.map((n) => n.updatedAt).sort().at(-1) ?? null;
  const repos = [...new Set(notifications.map((n) => n.repo))].slice(0, 3).join(' · ');
  return (
    <div className="mt-3 border-t hairline pt-3">
      <button
        type="button"
        onClick={onToggle}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
      >
        <span className="shrink-0 font-mono text-[11px] text-mist-faint">{open ? '▾' : '▸'}</span>
        <Chip className="text-mist-dim">review-bot digest</Chip>
        <span className="min-w-0 flex-1 truncate text-sm text-mist-dim">{repos}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-mist-faint">{notifications.length}</span>
        <RelTime iso={latest} />
      </button>
      {open && (
        <div className="mt-2 space-y-0.5">
          {notifications.map((n) => (
            <NotificationRow key={n.id} n={n} dispatches={dispatches} onClear={onClear} onOpenItem={onOpenItem} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Local working tree — facts only: dirty is normal work-in-flight, never an error,
 *  so the count stays mist-dim (no coral, no accent). */
function RepoRow({ r }: { r: RepoInfo }) {
  const arrows = [r.ahead ? `↑${r.ahead}` : null, r.behind ? `↓${r.behind}` : null].filter(Boolean).join(' ');
  return (
    <Row title={r.path}>
      <span className="min-w-0 flex-1 truncate text-sm text-mist">{r.name}</span>
      <span className="max-w-44 shrink-0 truncate font-mono text-xs text-mist-dim" title={r.branch ?? undefined}>
        {r.branch}
        {r.detached && <span className="text-mist-faint">detached</span>}
      </span>
      <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-mist-dim">
        {r.dirty > 0 ? r.dirty : ''}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-mist-faint">{arrows}</span>
      <RelTime iso={r.lastCommitAt} />
    </Row>
  );
}

const LOCAL_ROWS = 14;

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
  const [localOpen, setLocalOpen] = useState(false);
  const [reviewBotOpen, setReviewBotOpen] = useState(false);

  // older servers don't ship the repos section yet — skip the panel entirely
  const local = snapshot.repos as ReposState | undefined;

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
  const visibleNotifications = notifAll.filter(
    (n) => visible({ repo: n.repo }) && !isMuted(snapshot, 'github-reason', n.reason),
  );
  const reviewBotNotifications = visibleNotifications.filter((n) => n.noise?.kind === 'review-bot');
  const notifications = visibleNotifications.filter((n) => n.noise?.kind !== 'review-bot');
  const ownRepos = g.ownRepos.filter(visible);
  const quietPriorityCount =
    (g.orgQueue.length - orgQueue.length) + (g.actNow.length - actNow.length);

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
      <header className="mb-4 flex flex-wrap items-baseline justify-end gap-3 px-1">
        <div className="flex min-w-0 items-baseline gap-4 font-mono text-xs text-mist-dim">
          {g.error && (
            <span className="max-w-96 truncate text-coral" title={g.error}>
              {g.error}
            </span>
          )}
          {g.rateLimit && (() => {
            const { remaining, limit } = g.rateLimit;
            const usedPct = limit > 0 ? ((limit - remaining) / limit) * 100 : 0;
            const tone =
              remaining <= 0 || usedPct >= 95
                ? 'text-coral'
                : usedPct >= 80
                  ? 'text-amber'
                  : 'text-mist-dim';
            return (
              <span className={`tabular-nums ${tone}`} title="GitHub API rate limit">
                {remaining}/{limit}
              </span>
            );
          })()}
          <RelTime iso={g.updatedAt} />
        </div>
      </header>

      <div className="grid grid-cols-12 gap-5">
        {orgQueue.length === 0 && actNow.length === 0 ? (
          <section
            className="stat-band rise col-span-12 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            style={{ '--rise-i': 0 } as CSSProperties}
          >
            <Dot status="running" />
            <h2 className="text-[13px] font-semibold text-mist">Priority queue clear</h2>
            <span className="order-3 min-w-0 basis-full text-sm text-mist-faint sm:order-none sm:basis-auto sm:flex-1">
              No reviews, triage requests, or immediate actions.
            </span>
            {quietPriorityCount > 0 && <QuietChip count={quietPriorityCount} onClick={onOpenQuiet} />}
          </section>
        ) : (
          <>
            {orgQueue.length > 0 && (
              <Panel
                title="Waiting on you"
                riseIndex={0}
                className="col-span-12"
                quietCount={g.orgQueue.length - orgQueue.length}
                onQuietClick={onOpenQuiet}
                right={
                  // amber only while the review lane has items — a triage-only queue stays plain
                  <span
                    className={`font-mono text-xs tabular-nums ${orgReview.length > 0 ? 'text-amber' : 'text-mist-faint'}`}
                  >
                    {orgQueue.length}
                  </span>
                }
              >
                <div className="max-h-72 space-y-0.5 overflow-x-hidden overflow-y-auto">
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
              </Panel>
            )}

            {actNow.length > 0 && (
              <Panel
                title="Needs action"
                riseIndex={1}
                className="col-span-12"
                quietCount={g.actNow.length - actNow.length}
                onQuietClick={onOpenQuiet}
                right={<span className="font-mono text-xs tabular-nums text-amber">{actNow.length}</span>}
              >
                <div className="max-h-72 space-y-0.5 overflow-x-hidden overflow-y-auto">
                  {actNow.map((it) => (
                    <ItemRow key={it.id} item={it} dispatches={dispatches} onOpenItem={onOpenItem} accent />
                  ))}
                </div>
              </Panel>
            )}
          </>
        )}

        <Panel
          title="Your open pull requests"
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
            <EmptyState>You have no open pull requests.</EmptyState>
          ) : (
            <div className="max-h-80 space-y-0.5 overflow-x-hidden overflow-y-auto">
              {myPRs.map((pr) => (
                <PRRow key={pr.id} pr={pr} dispatches={dispatches} onOpenItem={onOpenItem} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Mentions"
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
            <EmptyState>No unread mentions.</EmptyState>
          ) : (
            <div className="max-h-80 space-y-0.5 overflow-x-hidden overflow-y-auto">
              {mentions.map((it) => (
                <ItemRow key={it.id} item={it} dispatches={dispatches} onOpenItem={onOpenItem} />
              ))}
            </div>
          )}
        </Panel>

        <section className="panel-surface rise col-span-12 p-4 xl:p-5" style={{ '--rise-i': 4 } as CSSProperties}>
          <header className="flex items-baseline justify-between gap-3">
            <button
              type="button"
              onClick={() => setTeamOpen((o) => !o)}
              aria-expanded={teamOpen}
              aria-controls="team-queue-items"
              className="flex min-h-8 min-w-0 cursor-pointer items-center gap-2 text-left"
            >
              <span className="font-mono text-[11px] text-mist-faint">{teamOpen ? '▾' : '▸'}</span>
              <h2 className="text-[13px] font-semibold text-mist">Team queue</h2>
              <span className="font-mono text-xs tabular-nums text-mist-dim">{teamQueue.length}</span>
            </button>
            {g.teamQueue.length - teamQueue.length > 0 && (
              <QuietChip count={g.teamQueue.length - teamQueue.length} onClick={onOpenQuiet} />
            )}
          </header>
          {teamOpen && (
            <div id="team-queue-items" className="mt-3 max-h-80 space-y-0.5 overflow-x-hidden overflow-y-auto">
              {teamQueue.length === 0 ? (
                <EmptyState>The team queue is clear.</EmptyState>
              ) : (
                teamQueue.map((pr) => <PRRow key={pr.id} pr={pr} dispatches={dispatches} onOpenItem={onOpenItem} />)
              )}
            </div>
          )}
        </section>

        <Panel
          title="Notifications"
          riseIndex={5}
          className="col-span-12"
          quietCount={notifAll.length - visibleNotifications.length}
          onQuietClick={onOpenQuiet}
          right={
            visibleNotifications.length > 0 ? (
              <>
                <span className="font-mono text-xs tabular-nums text-mist-faint">{notifications.length}</span>
                {reviewBotNotifications.length > 0 && (
                  <span className="font-mono text-[11px] tabular-nums text-mist-dim" title="collapsed review-bot notifications">
                    {reviewBotNotifications.length} bot
                  </span>
                )}
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
          {visibleNotifications.length === 0 ? (
            <EmptyState>No unread notifications.</EmptyState>
          ) : (
            <div className="max-h-96 overflow-x-hidden overflow-y-auto">
              {notifications.length > 0 && (
                <div className="space-y-0.5">
                  {notifications.map((n) => (
                    <NotificationRow
                      key={n.id}
                      n={n}
                      dispatches={dispatches}
                      onClear={clearOne}
                      onOpenItem={onOpenItem}
                    />
                  ))}
                </div>
              )}
              <ReviewBotDigest
                notifications={reviewBotNotifications}
                open={reviewBotOpen}
                onToggle={() => setReviewBotOpen((o) => !o)}
                dispatches={dispatches}
                onClear={clearOne}
                onOpenItem={onOpenItem}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Your repositories"
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
            <EmptyState>No repositories were returned.</EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {ownRepos.map((r) => (
                <Row key={r.repo} href={`https://github.com/${r.repo}`} title={r.repo} className="flex-wrap border hairline sm:flex-nowrap">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-mist">{r.repo}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-mist-dim">
                    {r.openIssues}
                    <span className="text-mist-faint"> iss </span>
                    {r.openPRs}
                    <span className="text-mist-faint"> pr</span>
                  </span>
                  <span className="row-actions mobile-row-actions ml-auto shrink-0 justify-end sm:ml-0 sm:basis-auto">
                    <RepoMutes repo={r.repo} />
                  </span>
                </Row>
              ))}
            </div>
          )}
        </Panel>

        {local && (
          <Panel
            title="Local changes"
            riseIndex={7}
            className="col-span-12"
            right={
              <>
                {local.error && (
                  <span className="max-w-64 truncate text-coral" title={local.error}>
                    {local.error}
                  </span>
                )}
                {local.repos.length > 0 && (
                  <span className="font-mono text-xs tabular-nums text-mist-faint">{local.repos.length}</span>
                )}
                <RelTime iso={local.updatedAt} />
              </>
            }
          >
            {local.repos.length === 0 ? (
              // never claim cleanliness from absence — null updatedAt means the
              // collector hasn't reported yet; non-null + zero means scan found nothing
              <EmptyState>
                {local.updatedAt === null ? 'Local repos have not been collected yet.' : 'No local repos were found.'}
              </EmptyState>
            ) : (
              <div className="space-y-0.5">
                {(localOpen ? local.repos : local.repos.slice(0, LOCAL_ROWS)).map((r) => (
                  <RepoRow key={r.path} r={r} />
                ))}
                {!localOpen && local.repos.length > LOCAL_ROWS && (
                  <button
                    type="button"
                    onClick={() => setLocalOpen(true)}
                    className="cursor-pointer py-1 pl-2.5 font-mono text-[11px] tabular-nums text-mist-faint transition-colors hover:text-mist"
                  >
                    … {local.repos.length - LOCAL_ROWS} more
                  </button>
                )}
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}
