import type { ReactNode } from 'react';
import type { ExtraSection, ShippedCommit, ShippedPR, ShippedReport } from '../../../shared/types';
import { RelTime } from '../components/ui';

// The day's receipt: every commit you authored since the local day start, in every
// repo on this machine, plus the PRs GitHub says you merged or opened. Read-only,
// nothing to press but the links. It exists for the last look before closing the
// lid: what actually landed. Live repo state (dirty trees, ahead/behind) is Tasks.
//
// Shape comes from ShippedReport in shared/types.ts; the extra lane carries `data`
// as unknown so this panel casts.

const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const count = (n: number): string => n.toLocaleString('en-US');

// list caps keep a very busy day scannable; the totals and the report carry everything
const COMMIT_CAP = 80;
const PR_CAP = 40;

function Stat({ label, value, className = 'text-mist' }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className="panel-surface rounded-lg p-4">
      <div className={`font-mono text-2xl tabular-nums ${className}`}>{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-mist-faint">{label}</div>
    </div>
  );
}

function Table({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="panel-surface rounded-lg p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-mist-faint">{title}</div>
        {note && <div className="font-mono text-[10px] text-mist-faint">{note}</div>}
      </div>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

/** 24 bars from the day start. The running hour is amber, hours still to come stay
 *  faint, so an empty evening reads as "not yet" rather than "nothing". */
function HourStrip({ report }: { report: ShippedReport }) {
  const since = new Date(report.since);
  const startHour = since.getHours();
  const nowIdx = Math.floor((Date.now() - since.getTime()) / 3_600_000);
  const max = Math.max(...report.byHour, 1);
  return (
    <div className="panel-surface rounded-lg p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-mist-faint">by hour</div>
        <div className="font-mono text-[10px] text-mist-faint">day starts {pad(startHour)}:00</div>
      </div>
      <div className="flex h-16 items-end gap-[3px]">
        {report.byHour.map((n, i) => {
          const hour = (startHour + i) % 24;
          const future = i > nowIdx;
          const current = i === nowIdx;
          const tone = n === 0 ? (future ? 'bg-mist/5' : 'bg-mist/10') : current ? 'bg-amber' : 'bg-jade';
          return (
            <div
              key={i}
              className="flex h-full flex-1 flex-col justify-end"
              title={`${pad(hour)}:00 · ${n} commit${n === 1 ? '' : 's'}`}
            >
              <div
                className={`w-full rounded-sm ${tone}`}
                style={{ height: n === 0 ? '2px' : `${Math.max(8, (n / max) * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-[3px] font-mono text-[9px] tabular-nums text-mist-faint">
        {report.byHour.map((_, i) => (
          <div key={i} className="flex-1 text-center">
            {i % 4 === 0 ? pad((startHour + i) % 24) : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

function RepoBars({ report }: { report: ShippedReport }) {
  const max = Math.max(...report.byRepo.map((r) => r.commits), 1);
  return (
    <div className="panel-surface rounded-lg p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-mist-faint">by repo</div>
        <div className="font-mono text-[10px] text-mist-faint">commits · lines</div>
      </div>
      <ul className="space-y-2">
        {report.byRepo.map((r) => (
          <li key={r.repo}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-mist-dim" title={r.repo}>
                {r.repo}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-mist">{r.commits}</span>{' '}
                <span className="text-jade">+{count(r.add)}</span>{' '}
                <span className="text-coral">-{count(r.del)}</span>
              </span>
            </div>
            <div className="mt-1 h-1 w-full rounded-full bg-mist/5">
              <div className="h-1 rounded-full bg-jade" style={{ width: `${(r.commits / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CommitRow({ c }: { c: ShippedCommit }) {
  const href = c.origin ? `https://github.com/${c.origin}/commit/${c.sha}` : null;
  const body = (
    <>
      <span className="w-11 shrink-0 font-mono text-xs tabular-nums text-mist-faint">{hhmm(c.at)}</span>
      <span className="w-28 shrink-0 truncate font-mono text-[10px] uppercase text-mist-faint" title={c.repo}>
        {c.repo}
      </span>
      <span className="min-w-0 flex-1 truncate text-mist-dim" title={c.subject}>
        {c.subject}
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums">
        <span className="text-jade">+{count(c.add)}</span> <span className="text-coral">-{count(c.del)}</span>
      </span>
    </>
  );
  return (
    <li className="text-sm">
      {href ? (
        <a
          className="flex min-w-0 items-baseline gap-3 hover:text-mist"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={c.sha}
        >
          {body}
        </a>
      ) : (
        <div className="flex min-w-0 items-baseline gap-3" title={c.sha}>
          {body}
        </div>
      )}
    </li>
  );
}

function PrRow({ p }: { p: ShippedPR }) {
  const pill = p.state === 'merged' ? 'bg-jade/15 text-jade' : 'bg-amber/15 text-amber';
  return (
    <li className="text-sm">
      <a
        className="flex min-w-0 items-baseline gap-3 hover:text-mist"
        href={p.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${pill}`}>
          {p.state}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-mist-faint">
          {p.repo}#{p.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-mist-dim" title={p.title}>
          {p.title}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-mist-faint">{hhmm(p.at)}</span>
      </a>
    </li>
  );
}

export default function ShippedPanel({ section }: { section: ExtraSection }) {
  const report = (section.data ?? null) as ShippedReport | null;
  const t = report?.totals;
  const quiet = !!t && t.commits === 0 && t.prsMerged === 0 && t.prsOpened === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold lowercase tracking-wide text-mist">{section.title ?? 'shipped today'}</h2>
        <span className="font-mono text-[11px] text-mist-faint">
          {report && <>since {hhmm(report.since)} · </>}
          {section.up === false ? 'down' : <RelTime iso={section.updatedAt} />}
        </span>
      </div>

      {section.error && <div className="panel-surface rounded-lg p-4 text-sm text-coral">{section.error}</div>}

      {!report && !section.error && (
        <div className="panel-surface rounded-lg p-4 text-sm text-mist-faint">Walking the repos.</div>
      )}

      {report && t && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="commits" value={count(t.commits)} className={t.commits ? 'text-mist' : 'text-mist-faint'} />
            <Stat label="repos touched" value={count(t.repos)} className={t.repos ? 'text-mist' : 'text-mist-faint'} />
            <Stat
              label="lines"
              value={
                <>
                  <span className="text-jade">+{count(t.add)}</span> <span className="text-coral">-{count(t.del)}</span>
                </>
              }
            />
            <Stat
              label={report.prsError ? 'prs merged (unknown)' : report.prsCapped ? 'prs merged (at least)' : 'prs merged'}
              value={report.prsError ? '?' : `${count(t.prsMerged)}${report.prsCapped ? '+' : ''}`}
              className={!report.prsError && t.prsMerged ? 'text-jade' : 'text-mist-faint'}
            />
          </div>

          {/* the collector stays up when only GitHub fails, so this is the one place
              the failure shows; it must not hide behind the quiet-day branch */}
          {report.prsError && (
            <div className="panel-surface rounded-lg p-4 text-sm text-coral">
              GitHub PR search failed, so the PR counts and list are missing: {report.prsError}
            </div>
          )}

          <HourStrip report={report} />

          {quiet && (
            <div className="panel-surface rounded-lg p-4 text-sm text-mist-faint">
              Nothing has landed since {hhmm(report.since)}. The first commit shows up here on the next poll.
            </div>
          )}

          {!quiet && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <RepoBars report={report} />
              <Table title="pull requests" note={report.prsCapped ? 'merged and opened today · list capped, newest kept' : 'merged and opened today'}>
                {report.prsError && <li className="text-sm text-mist-faint">unavailable, see above</li>}
                {!report.prsError && report.prs.length === 0 && <li className="text-sm text-mist-faint">none today</li>}
                {report.prs.slice(0, PR_CAP).map((p) => (
                  <PrRow key={p.url} p={p} />
                ))}
                {report.prs.length > PR_CAP && (
                  <li className="text-xs text-mist-faint">and {count(report.prs.length - PR_CAP)} more</li>
                )}
              </Table>
            </div>
          )}

          {t.commits > 0 && (
            <Table title="commits" note={`${count(t.commits)} · newest first`}>
              {report.commits.slice(0, COMMIT_CAP).map((c) => (
                <CommitRow key={`${c.repo}:${c.sha}`} c={c} />
              ))}
              {report.commits.length > COMMIT_CAP && (
                <li className="text-xs text-mist-faint">and {count(report.commits.length - COMMIT_CAP)} more</li>
              )}
            </Table>
          )}
        </>
      )}
    </div>
  );
}
