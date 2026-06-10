import { useState, type CSSProperties } from 'react';
import type { Snapshot, SubService } from '../../../shared/types';
import { connectSpotify, spotifySetClient } from '../api';
import { CopyText, Dot, EmptyState, Row } from '../components/ui';

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
                {/* detail carries real local stats from the server — render verbatim.
                    spotify not-connected swaps the CTA text for the in-app setup. */}
                {s.id === 'spotify' && s.status === 'not-connected' ? (
                  <SpotifySetup />
                ) : (
                  s.detail &&
                  (s.status === 'not-connected' ? (
                    <div className="mt-1 text-xs text-amber">{s.detail}</div>
                  ) : (
                    <div className="mt-1 text-xs text-mist-dim" title={s.detail}>
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
