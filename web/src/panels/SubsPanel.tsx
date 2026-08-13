import { useState, type CSSProperties } from 'react';
import type { CloudState, Snapshot, SubService } from '../../../shared/types';
import { connectSpotify, spotifySetClient } from '../api';
import { CopyText, Dot, EmptyState, RelTime, Row } from '../components/ui';

/** Click on a card header lands on the service's own console. */
const CONSOLE_URL: Record<string, string> = {
  claude: 'https://console.aws.amazon.com/bedrock/home',
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
    case 'upcoming':
      return 'idle';
    default:
      return 'unknown';
  }
}

function barFill(pct: number): string {
  return pct < 60 ? 'bg-jade' : pct < 85 ? 'bg-amber' : 'bg-coral';
}

function UsageMeter({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const fill = barFill(pct);
  return (
    <div className="usage-meter" title={`${Math.round(pct)}%`}>
      <span className="usage-meter-track" />
      <span className={`usage-meter-fill ${fill}`} style={{ width: `${clamped}%` }} />
      <span className={`usage-meter-tick ${fill}`} style={{ left: `${clamped}%` }} />
    </div>
  );
}

/** Must match the server's redirect byte-for-byte — spotify rejects any mismatch. */
const SPOTIFY_REDIRECT = 'http://127.0.0.1:5599/api/spotify/callback';

/** Two-step in-app spotify setup (DESIGN: self-serve recovery — no terminal detours).
 *  1) create an app at developer.spotify.com with the exact redirect below, paste its
 *  Client ID, save. 2) connect — server-owned PKCE consent opens in a new tab; the
 *  callback re-runs the subs collector, so the card flips to active over SSE by itself. */
function SpotifySetup() {
  const [clientId, setClientId] = useState('');
  const [save, setSave] = useState<'idle' | 'busy' | 'saved' | 'failed'>('idle');
  const [connect, setConnect] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-2 space-y-2">
      <div className="text-xs text-mist-dim">
        create an app at developer.spotify.com with redirect{' '}
        <CopyText text={SPOTIFY_REDIRECT} className="break-all font-mono text-[11px] text-mist-dim hover:text-mist">
          {SPOTIFY_REDIRECT}
        </CopyText>{' '}
        then paste its client id
      </div>
      <div className="flex items-center gap-2">
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="client id"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded border hairline bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-mist placeholder:text-mist-faint focus:border-white/25 focus:outline-none"
        />
        <button
          type="button"
          disabled={save === 'busy' || clientId.trim() === ''}
          onClick={async () => {
            setSave('busy');
            setError(null);
            try {
              await spotifySetClient(clientId.trim());
              setSave('saved');
            } catch (e) {
              setSave('failed');
              setError(e instanceof Error ? e.message : String(e));
            }
            setTimeout(() => setSave((s) => (s === 'busy' ? s : 'idle')), 2500);
          }}
          className={`shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-40 ${
            save === 'saved' ? 'text-jade' : save === 'failed' ? 'text-coral' : 'text-mist-faint hover:text-amber'
          }`}
        >
          {save === 'busy' ? '…' : save === 'saved' ? 'saved' : save === 'failed' ? 'failed' : 'save'}
        </button>
      </div>
      <button
        type="button"
        disabled={connect === 'busy'}
        onClick={async () => {
          setConnect('busy');
          setError(null);
          try {
            await connectSpotify();
            setConnect('idle');
          } catch (e) {
            setConnect('failed');
            setError(e instanceof Error ? e.message : String(e));
            setTimeout(() => setConnect((s) => (s === 'busy' ? s : 'idle')), 4000);
          }
        }}
        className="w-full rounded-lg bg-amber/15 px-3 py-1.5 font-mono text-xs text-amber transition-colors hover:bg-amber/25 disabled:opacity-40"
      >
        {connect === 'busy' ? '…' : connect === 'failed' ? 'failed — retry' : 'connect spotify'}
      </button>
      {error && (
        <div className="truncate font-mono text-[11px] text-coral" title={error}>
          {error}
        </div>
      )}
    </div>
  );
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

/** Recover the typed calendar date as a local midnight. The server round-trips a
 *  date-only value through UTC, so the ISO's date part IS the calendar date as
 *  typed; rebuilding it locally makes the countdown whole calendar days — no
 *  hour-of-day flicker and no off-by-one against how a human counts "in 18 days". */
function calDate(iso: string): Date | null {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

function todayLocal(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function StartsIn({ iso }: { iso: string }) {
  const t = calDate(iso);
  if (!t) return null;
  const days = daysBetween(t, todayLocal());
  const rel = days <= 0 ? 'today' : `in ${days}d`;
  return (
    <span className="font-mono text-[10px] tabular-nums text-mist-faint" title={`starts ${t.toLocaleDateString()}`}>
      {rel}
    </span>
  );
}

function CancelStatus({ iso }: { iso: string }) {
  const t = calDate(iso);
  if (!t) return null;
  const days = daysBetween(t, todayLocal());
  if (days < 0) {
    return (
      <span
        className="font-mono text-[10px] tabular-nums text-amber"
        title={`cancel date ${t.toLocaleDateString()} passed`}
      >
        cancel date passed — still billing?
      </span>
    );
  }
  const rel = days === 0 ? 'today' : `in ${days}d`;
  return (
    <>
      cancels{' '}
      <span
        className="font-mono text-[10px] tabular-nums text-mist-faint"
        title={`cancels ${t.toLocaleDateString()}`}
      >
        {rel}
      </span>
    </>
  );
}

function Uptime({ launched }: { launched: string | null }) {
  if (!launched) return <span className="shrink-0 font-mono text-[11px] text-mist-faint">—</span>;
  const s = Math.max(0, Math.floor((Date.now() - new Date(launched).getTime()) / 1000));
  const rel = s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return (
    <span
      className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-mist-faint"
      title={`launched ${new Date(launched).toLocaleString()}`}
    >
      up {rel}
    </span>
  );
}

/** cloud — ec2. INFORMATIONAL ONLY: running fleets are the owner's normal work
 *  state, so cost is data — neutral mist, never amber/coral, no alerts. */
function CloudCard({ cloud, riseIndex }: { cloud: CloudState; riseIndex: number }) {
  const { instances, totalMonthlyUsd, updatedAt, error } = cloud;
  return (
    <article className="panel-surface rise flex min-w-0 flex-col p-4" style={{ '--rise-i': riseIndex } as CSSProperties}>
      <Row href="https://console.aws.amazon.com/ec2/home#Instances:">
        <div className="flex w-full min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold text-mist">cloud — ec2</h3>
          <span className="hover-cluster shrink-0 font-mono text-[10px] text-mist-faint">↗</span>
          <span className="flex-1" />
          <RelTime iso={updatedAt} />
          <Dot status={updatedAt && !error ? 'running' : 'idle'} />
        </div>
      </Row>

      {error && (
        <div className="mt-1 truncate font-mono text-[11px] text-coral" title={error}>
          {error}
        </div>
      )}

      {instances.length > 0 ? (
        <div className="mt-2 space-y-1 px-2.5">
          {instances.map((i) => (
            <div key={i.id} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-xs text-mist" title={i.name ? `${i.name} (${i.id})` : i.id}>
                {i.name ?? i.id}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-mist-faint">
                {i.type}
                {i.az ? ` · ${i.az}` : ''}
              </span>
              <span className="flex-1" />
              <Uptime launched={i.launchedAt} />
              <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-mist-dim">
                {i.monthlyUsd !== null ? `$${i.monthlyUsd.toFixed(0)}/mo` : '—'}
              </span>
            </div>
          ))}
          {totalMonthlyUsd !== null && (
            <div
              className="flex items-baseline justify-between pt-1"
              title="rough us-east-2 on-demand estimate × 730h; unknown types excluded"
            >
              <span className="text-[11px] text-mist-dim">est. total</span>
              <span className="font-mono text-[11px] tabular-nums text-mist">${totalMonthlyUsd.toFixed(2)}/mo</span>
            </div>
          )}
        </div>
      ) : (
        !error && (
          <div className="mt-2 px-2.5 text-xs text-mist-faint">
            {updatedAt === null ? 'Waiting for the first poll.' : 'No running instances.'}
          </div>
        )
      )}

      <div className="mt-auto min-w-0 pt-3">
        <CopyText text="aws ec2 describe-instances" className="block w-full">
          <span className="block truncate font-mono text-[10px] text-mist-faint">aws ec2 describe-instances</span>
        </CopyText>
      </div>
    </article>
  );
}

export default function SubsPanel({ snapshot }: { snapshot: Snapshot }) {
  const { services, error } = snapshot.subs;

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">{error}</div>
      )}
      {services.length === 0 && <EmptyState>No subscriptions were discovered yet.</EmptyState>}
      <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
        {services.map((s, i) => {
            const consoleUrl = CONSOLE_URL[s.id] ?? null;
            return (
              <article
                key={s.id}
                className="panel-surface rise flex min-w-0 flex-col p-4"
                style={{ '--rise-i': i } as CSSProperties}
              >
                <Row href={consoleUrl ?? undefined}>
                  <div className="flex w-full min-w-0 items-center gap-2">
                    {consoleUrl ? (
                      <h3 className="min-w-0 truncate text-sm font-semibold text-mist">{s.name}</h3>
                    ) : (
                      <h3 className="min-w-0 truncate text-sm font-semibold text-mist">
                        <CopyText text={s.id}>{s.name}</CopyText>
                      </h3>
                    )}
                    {consoleUrl && (
                      <span className="hover-cluster shrink-0 font-mono text-[10px] text-mist-faint">↗</span>
                    )}
                    <span className="flex-1" />
                    <Dot status={dotStatus(s.status)} />
                  </div>
                </Row>

                {s.status === 'upcoming' && s.startsAt && (
                  <div className="mt-1 text-xs text-mist-dim">
                    starts <StartsIn iso={s.startsAt} />
                  </div>
                )}
                {s.status === 'active' && s.endsAt && (
                  <div className="mt-1 text-xs text-mist-dim">
                    <CancelStatus iso={s.endsAt} />
                  </div>
                )}
                {s.plan && <div className="mt-1 text-xs text-mist-dim">{s.plan}</div>}
                {/* detail carries real local stats from the server — render verbatim.
                    spotify not-connected swaps the CTA text for the in-app setup. */}
                {s.id === 'spotify' && s.status === 'not-connected' ? (
                  <SpotifySetup />
                ) : (
                  s.detail &&
                  (s.status === 'not-connected' ? (
                    <div className="mt-1 truncate text-xs text-amber" title={s.detail}>
                      {s.detail}
                    </div>
                  ) : (
                    <div className="mt-1 truncate text-xs text-mist-dim" title={s.detail}>
                      {s.detail}
                    </div>
                  ))
                )}

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
                          <UsageMeter pct={pct} />
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

                <div className="mt-auto min-w-0 pt-3">
                  <CopyText text={s.source} className="block w-full">
                    <span className="block truncate font-mono text-[10px] text-mist-faint" title={s.source}>
                      {s.source}
                    </span>
                  </CopyText>
                </div>
              </article>
            );
          })}
        {/* older servers omit cloud — destructuring undefined would white-screen (no ErrorBoundary) */}
        {snapshot.cloud && <CloudCard cloud={snapshot.cloud} riseIndex={services.length} />}
      </div>
    </div>
  );
}
