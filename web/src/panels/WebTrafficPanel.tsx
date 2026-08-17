import type { ExtraSection } from '../../../shared/types';
import { RelTime } from '../components/ui';
import Spark from '../components/Spark';

// The two public sites' cookieless analytics, rendered from the webtraffic
// collector's report. Read-only by design: there is no action to take here and no
// button to press — the panel exists so channel and traffic questions are answered
// by looking up, not by running darklanes scripts in a terminal.
//
// The shape below mirrors WebTrafficReport in server/src/core/webtraffic.ts (the
// extra lane carries `data` as unknown, so the contract is restated here).

interface Report {
  days: number;
  totals: Array<{ site: string; views: number }>;
  daily: Array<{ day: string; site: string; views: number }>;
  topPaths: Array<{ site: string; path: string; views: number }>;
  referrers: Array<{ kind: string; host: string; views: number }>;
  channels: Array<{ channel: string; views: number; prevViews: number; delta: number }>;
}

const SITE_HOST: Record<string, string> = { lab: 'tiyuvta.ai', app: 'inference.tiyuvta.ai' };

const count = (n: number): string => n.toLocaleString('en-US');

/** The last `days` UTC calendar days, oldest first — matches the collector's
 *  day buckets, and keeps zero-traffic days visible instead of collapsing them. */
function dayAxis(days: number): string[] {
  const today = Date.now();
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

function SiteCard({ site, report }: { site: string; report: Report }) {
  const axis = dayAxis(report.days);
  const byDay = new Map(report.daily.filter((d) => d.site === site).map((d) => [d.day, d.views]));
  const series = axis.map((day) => byDay.get(day) ?? 0);
  const total = series.reduce((sum, v) => sum + v, 0);
  const max = Math.max(...series, 1);
  const today = series[series.length - 1] ?? 0;
  return (
    <div className="panel-surface rounded-lg p-4">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-sm text-mist-dim">{SITE_HOST[site] ?? site}</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">{site}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-2xl tabular-nums text-mist">{count(total)}</div>
          <div className="font-mono text-[11px] text-mist-faint">
            views, {report.days}d · {count(today)} today
          </div>
        </div>
        <Spark series={series.map((v) => (v / max) * 100)} width={96} height={24} className="mb-1 shrink-0 text-jade" />
      </div>
    </div>
  );
}

function Table({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
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

export default function WebTrafficPanel({ section }: { section: ExtraSection }) {
  const report = (section.data ?? null) as Report | null;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold lowercase tracking-wide text-mist">
          {section.title ?? 'web traffic'}
        </h2>
        <span className="font-mono text-[11px] text-mist-faint">
          {section.up === false ? 'down' : <RelTime iso={section.updatedAt} />}
        </span>
      </div>

      {section.error && (
        <div className="panel-surface rounded-lg p-4 text-sm text-coral">{section.error}</div>
      )}

      {!report && !section.error && (
        <div className="panel-surface rounded-lg p-4 text-sm text-mist-faint">No data yet.</div>
      )}

      {report && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {(report.totals.length ? report.totals.map((t) => t.site) : ['lab', 'app']).map((site) => (
              <SiteCard key={site} site={site} report={report} />
            ))}
          </div>

          <Table title="channels" note={`vs prior ${report.days}d · ?c= campaign wins over referrer`}>
            {report.channels.length === 0 && (
              <li className="text-sm text-mist-faint">no attributable views in the window</li>
            )}
            {report.channels.map((channel) => (
              <li key={channel.channel} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-mist-dim">{channel.channel}</span>
                <span className="flex shrink-0 items-baseline gap-3 font-mono text-xs tabular-nums">
                  <span className="text-mist">{count(channel.views)}</span>
                  <span
                    className={
                      channel.delta > 0 ? 'text-jade' : channel.delta < 0 ? 'text-coral' : 'text-mist-faint'
                    }
                  >
                    {channel.delta > 0 ? `+${count(channel.delta)}` : count(channel.delta)}
                  </span>
                </span>
              </li>
            ))}
          </Table>

          <div className="grid gap-4 lg:grid-cols-2">
            <Table title="top pages" note={`last ${report.days}d`}>
              {report.topPaths.length === 0 && (
                <li className="text-sm text-mist-faint">no views in the window</li>
              )}
              {report.topPaths.map((page) => (
                <li key={`${page.site}${page.path}`} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-mist-dim" title={`${page.site} ${page.path}`}>
                    <span className="font-mono text-[10px] uppercase text-mist-faint">{page.site}</span>{' '}
                    {page.path}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-mist">{count(page.views)}</span>
                </li>
              ))}
            </Table>

            <Table title="referrers" note="internal journeys excluded">
              {report.referrers.length === 0 && (
                <li className="text-sm text-mist-faint">no external referrers in the window</li>
              )}
              {report.referrers.map((ref, i) => (
                <li key={`${ref.kind}${ref.host}${i}`} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-mist-dim" title={ref.host || ref.kind}>
                    <span className="font-mono text-[10px] uppercase text-mist-faint">{ref.kind}</span>{' '}
                    {ref.host || 'direct'}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-mist">{count(ref.views)}</span>
                </li>
              ))}
            </Table>
          </div>

          <p className="text-[11px] text-mist-faint">
            Cookieless beacon — no visitor ids, so channels count views, not people.
            Analytics Engine keeps three months; snapshot anything that must outlive that.
          </p>
        </>
      )}
    </div>
  );
}
