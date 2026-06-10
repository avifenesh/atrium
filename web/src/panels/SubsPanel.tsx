import type { CSSProperties } from 'react';
import type { Snapshot, SubService } from '../../../shared/types';
import { Dot, EmptyState, Row } from '../components/ui';

/** Click on a card header lands on the service's own console. */
const CONSOLE_URL: Record<string, string> = {
  claude: 'https://claude.ai/settings/usage',
  grok: 'https://console.x.ai',
  copilot: 'https://github.com/settings/copilot',
  zai: 'https://z.ai',
  codex: 'https://chatgpt.com',
  spotify: 'https://www.spotify.com/account',
};

function dotStatus(s: SubService['status']): string {
  // map onto the .dot-* classes: jade / mist-faint / amber / mist-faint
  switch (s) {
    case 'active':
      return 'running';
    case 'off':
      return 'off';
    case 'not-connected':
      return 'active';
    default:
      return 'unknown';
  }
}

function barFill(pct: number): string {
  return pct < 60 ? 'bg-jade' : pct < 85 ? 'bg-amber' : 'bg-coral';
}

function ResetsIn({ iso }: { iso: string | null }) {
  if (!iso) return null;
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  const rel =
    s <= 0 ? 'now' : s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return (
    <span className="font-mono text-[10px] tabular-nums text-mist-faint" title={new Date(iso).toLocaleString()}>
      resets {s <= 0 ? rel : `in ${rel}`}
    </span>
  );
}

export default function SubsPanel({ snapshot }: { snapshot: Snapshot }) {
  const { services, error } = snapshot.subs;

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</div>
      )}
      {services.length === 0 ? (
        <EmptyState>no subscriptions discovered</EmptyState>
      ) : (
        <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
          {services.map((s, i) => {
            const consoleUrl = CONSOLE_URL[s.id] ?? null;
            return (
              <article
                key={s.id}
                className="glass rise flex min-w-0 flex-col p-4"
                style={{ '--rise-i': i } as CSSProperties}
              >
                <Row href={consoleUrl ?? undefined}>
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <h3 className="min-w-0 truncate text-sm font-semibold text-mist">{s.name}</h3>
                    {consoleUrl && (
                      <span className="invisible shrink-0 font-mono text-[10px] text-mist-faint group-hover:visible group-focus-within:visible">
                        ↗
                      </span>
                    )}
                    <span className="flex-1" />
                    <Dot status={dotStatus(s.status)} />
                  </div>
                </Row>

                {s.plan && <div className="mt-1 text-xs text-mist-dim">{s.plan}</div>}
                {/* detail carries real local stats from the server — render verbatim */}
                {s.detail &&
                  (s.status === 'not-connected' ? (
                    <div className="mt-1 text-xs text-amber">{s.detail}</div>
                  ) : (
                    <div className="mt-1 text-xs text-mist-dim" title={s.detail}>
                      {s.detail}
                    </div>
                  ))}

                {s.usage && s.usage.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {s.usage.map((u) => {
                      const pct = Math.min(100, Math.max(0, u.usedPct));
                      return (
                        <div key={u.label}>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate text-[11px] text-mist-dim">{u.label}</span>
                            <span className="shrink-0 font-mono text-[11px] tabular-nums text-mist-dim">
                              {Math.round(u.usedPct)}%
                            </span>
                          </div>
                          <div className="mt-1 h-1 rounded-full bg-white/10">
                            <div className={`h-1 rounded-full ${barFill(u.usedPct)}`} style={{ width: `${pct}%` }} />
                          </div>
                          {u.resetAt && (
                            <div className="mt-0.5 text-right">
                              <ResetsIn iso={u.resetAt} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-auto truncate pt-3 font-mono text-[10px] text-mist-faint" title={s.source}>
                  {s.source}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
