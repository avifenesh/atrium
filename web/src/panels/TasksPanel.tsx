import { useState, type CSSProperties, type ReactNode } from 'react';
import { Dot, EmptyState, MuteButton, Mutable, Panel, RelTime } from '../components/ui';
import type { GithubItem, GithubPR, Snapshot } from '../../../shared/types';

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
    <span className={`shrink-0 rounded border hairline px-1.5 py-px font-mono text-[10px] ${className}`}>
      {children}
    </span>
  );
}

/** Hover cluster: quiet the repo, then a fainter quiet for its whole org. */
function RepoMutes({ repo }: { repo: string }) {
  const owner = repo.includes('/') ? repo.slice(0, repo.indexOf('/')) : repo;
  return (
    <span className="flex shrink-0 items-center">
      <MuteButton kind="github-repo" target={repo} />
      <MuteButton kind="github-org" target={owner} className="opacity-60" />
    </span>
  );
}

function ItemRow({ snapshot, item }: { snapshot: Snapshot; item: GithubItem }) {
  return (
    <Mutable snapshot={snapshot} kind="github-repo" target={item.repo}>
      <div className="group flex items-center gap-3 py-1.5">
        <span className="w-44 shrink-0 truncate font-mono text-xs text-mist-faint">{item.repo}</span>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-sm text-mist hover:text-slate-glow"
        >
          {item.title}
        </a>
        <RelTime iso={item.updatedAt} />
        <RepoMutes repo={item.repo} />
      </div>
    </Mutable>
  );
}

function PRRow({ snapshot, pr }: { snapshot: Snapshot; pr: GithubPR }) {
  const decision = pr.reviewDecision ? DECISION[pr.reviewDecision] : null;
  return (
    <Mutable snapshot={snapshot} kind="github-repo" target={pr.repo}>
      <div className="group flex items-center gap-3 py-1.5">
        <Dot status={ciStatus(pr.ci)} />
        <span className="w-40 shrink-0 truncate font-mono text-xs text-mist-faint">{pr.repo}</span>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-sm text-mist hover:text-slate-glow"
        >
          {pr.title}
        </a>
        {pr.isDraft && <Chip className="text-mist-faint">draft</Chip>}
        {decision && <Chip className={decision.cls}>{decision.label}</Chip>}
        <RelTime iso={pr.updatedAt} />
        <RepoMutes repo={pr.repo} />
      </div>
    </Mutable>
  );
}

export default function TasksPanel({ snapshot }: { snapshot: Snapshot }) {
  const g = snapshot.github;
  const [teamOpen, setTeamOpen] = useState(false);

  return (
    <div>
      <header className="mb-5 flex items-baseline justify-between px-1">
        <h1 className="font-display text-3xl italic text-mist">tasks</h1>
        <div className="flex items-baseline gap-4 font-mono text-xs text-mist-dim">
          {g.error && <span className="max-w-96 truncate text-coral">{g.error}</span>}
          {g.rateLimit && (
            <span title="github rate limit">
              {g.rateLimit.remaining}/{g.rateLimit.limit}
            </span>
          )}
          <RelTime iso={g.updatedAt} />
        </div>
      </header>

      <div className="grid grid-cols-12 gap-5">
        <Panel title="act now" riseIndex={0} className="col-span-12">
          {g.actNow.length === 0 ? (
            <EmptyState>nothing urgent</EmptyState>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {g.actNow.map((it) => (
                <ItemRow key={it.id} snapshot={snapshot} item={it} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="my open PRs" riseIndex={1} className="col-span-7">
          {g.myPRs.length === 0 ? (
            <EmptyState>no open prs</EmptyState>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {g.myPRs.map((pr) => (
                <PRRow key={pr.id} snapshot={snapshot} pr={pr} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="mentions" riseIndex={2} className="col-span-5">
          {g.mentions.length === 0 ? (
            <EmptyState>no mentions</EmptyState>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {g.mentions.map((it) => (
                <ItemRow key={it.id} snapshot={snapshot} item={it} />
              ))}
            </div>
          )}
        </Panel>

        <section className="glass rise col-span-12 p-5" style={{ '--rise-i': 3 } as CSSProperties}>
          <button
            onClick={() => setTeamOpen((o) => !o)}
            className="flex w-full items-baseline gap-2 text-left"
          >
            <span className="font-mono text-xs text-mist-faint">{teamOpen ? '▾' : '▸'}</span>
            <h2 className="font-display text-xl italic text-mist">team queue</h2>
            <span className="font-mono text-sm text-mist-dim">{g.teamQueue.length}</span>
          </button>
          {teamOpen && (
            <div className="mt-3 max-h-80 overflow-y-auto">
              {g.teamQueue.length === 0 ? (
                <EmptyState>queue empty</EmptyState>
              ) : (
                g.teamQueue.map((pr) => <PRRow key={pr.id} snapshot={snapshot} pr={pr} />)
              )}
            </div>
          )}
        </section>

        <Panel title="notifications" riseIndex={4} className="col-span-7">
          {g.notifications.length === 0 ? (
            <EmptyState>no notifications</EmptyState>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {g.notifications.map((n) => (
                <Mutable key={n.id} snapshot={snapshot} kind="github-repo" target={n.repo}>
                  {/* nested wrapper so reason mutes (the button below) actually dim the row */}
                  <Mutable snapshot={snapshot} kind="github-reason" target={n.reason}>
                  <div className="group flex items-center gap-2 py-1.5">
                    <Chip className="text-mist-dim">{n.reason}</Chip>
                    <MuteButton kind="github-reason" target={n.reason} className="opacity-60" />
                    <span className="w-36 shrink-0 truncate font-mono text-xs text-mist-faint">{n.repo}</span>
                    <a
                      href={n.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`min-w-0 flex-1 truncate text-sm hover:text-slate-glow ${
                        n.unread ? 'text-mist' : 'text-mist-dim'
                      }`}
                    >
                      {n.title}
                    </a>
                    <RelTime iso={n.updatedAt} />
                    <RepoMutes repo={n.repo} />
                  </div>
                  </Mutable>
                </Mutable>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="my repos" riseIndex={5} className="col-span-5">
          {g.ownRepos.length === 0 ? (
            <EmptyState>no repos</EmptyState>
          ) : (
            <div className="grid max-h-96 grid-cols-1 gap-2 overflow-y-auto xl:grid-cols-2">
              {g.ownRepos.map((r) => (
                <Mutable key={r.repo} snapshot={snapshot} kind="github-repo" target={r.repo}>
                  <div className="group flex items-center gap-2 rounded-lg border hairline px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-mist">{r.repo}</span>
                    <span className="shrink-0 font-mono text-xs text-mist-dim">
                      {r.openIssues}
                      <span className="text-mist-faint"> iss </span>
                      {r.openPRs}
                      <span className="text-mist-faint"> pr</span>
                    </span>
                    <RepoMutes repo={r.repo} />
                  </div>
                </Mutable>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
