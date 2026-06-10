import { useEffect, useState } from 'react';
import type { Snapshot, Mute, MuteKind } from '../../../shared/types';
import { addMute, removeMute } from '../api';
import { SectionLabel, EmptyState } from './ui';

const KINDS: { kind: MuteKind; placeholder: string }[] = [
  { kind: 'github-item', placeholder: 'owner/repo#123' },
  { kind: 'github-repo', placeholder: 'owner/repo' },
  { kind: 'github-org', placeholder: 'org' },
  { kind: 'github-reason', placeholder: 'review_requested' },
  { kind: 'agent', placeholder: 'revuto' },
  { kind: 'agent-resource', placeholder: 'revuto:owner/repo' },
  { kind: 'schedule', placeholder: 'hermes:job-id' },
  { kind: 'service', placeholder: 'unit.service' },
  { kind: 'flag', placeholder: 'flag id' },
];

const DURATIONS = ['1h', '4h', 'today', '24h', '7d', 'forever'] as const;
type Duration = (typeof DURATIONS)[number];

function untilFor(d: Duration): string | null {
  const now = Date.now();
  switch (d) {
    case '1h':
      return new Date(now + 3_600_000).toISOString();
    case '4h':
      return new Date(now + 4 * 3_600_000).toISOString();
    case 'today': {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      return end.toISOString();
    }
    case '24h':
      return new Date(now + 86_400_000).toISOString();
    case '7d':
      return new Date(now + 7 * 86_400_000).toISOString();
    case 'forever':
      return null;
  }
}

function Until({ iso }: { iso: string | null }) {
  if (!iso) return <span className="font-mono text-xs text-mist-dim">∞</span>;
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  const rel =
    s <= 0 ? 'now' : s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return (
    <span className="font-mono text-xs tabular-nums text-mist-dim" title={new Date(iso).toLocaleString()}>
      {s <= 0 ? rel : `in ${rel}`}
    </span>
  );
}

const LABEL = 'mb-1 block font-mono text-[10px] uppercase tracking-widest text-mist-faint';
const FIELD =
  'w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-mist placeholder:text-mist-faint focus:border-amber/50 focus:outline-none';

/** UnmuteButton with archive language — the drawer is where things come back from. */
function RestoreButton({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  return (
    <button
      type="button"
      disabled={state === 'busy'}
      onClick={async () => {
        setState('busy');
        try {
          await removeMute(id);
          setState('idle');
        } catch {
          setState('failed');
          setTimeout(() => setState('idle'), 4000);
        }
      }}
      className={`shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        state === 'failed' ? 'text-coral' : 'text-amber hover:text-mist'
      }`}
    >
      {state === 'busy' ? '…' : state === 'failed' ? 'failed' : 'restore'}
    </button>
  );
}

function MuteEntry({ m }: { m: Mute }) {
  return (
    <li className="flex items-center gap-2 border-b py-2 last:border-b-0 hairline">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-mist" title={m.target}>
          {m.target}
        </div>
        {m.enforcedBy && (
          <div className="truncate font-mono text-[10px] text-mist-faint" title={m.enforcedBy}>
            {m.enforcedBy}
          </div>
        )}
      </div>
      <Until iso={m.until} />
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
          m.mode === 'enforced' ? 'bg-amber/15 text-amber' : 'bg-white/5 text-mist-faint'
        }`}
      >
        {m.mode === 'enforced' ? 'enforced' : 'ui'}
      </span>
      <RestoreButton id={m.id} />
    </li>
  );
}

export default function MutesDrawer({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [kind, setKind] = useState<MuteKind>('github-repo');
  const [target, setTarget] = useState('');
  const [duration, setDuration] = useState<Duration>('forever');
  const [enforce, setEnforce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const active = snapshot.mutes.filter((m) => !m.until || new Date(m.until).getTime() > Date.now());

  // group by kind, in KINDS order, then anything unexpected at the end
  const knownOrder = KINDS.map((k) => k.kind);
  const groups = new Map<MuteKind, Mute[]>();
  for (const k of knownOrder) groups.set(k, []);
  for (const m of active) {
    const list = groups.get(m.kind);
    if (list) list.push(m);
    else groups.set(m.kind, [m]);
  }

  const submit = async () => {
    const t = target.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addMute({ kind, target: t, until: untilFor(duration), enforce });
      setTarget('');
      setDuration('forever');
      setEnforce(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/60" onClick={onClose} />
      <aside className="glass-raised fixed inset-y-0 right-0 z-40 flex w-96 flex-col overflow-y-auto p-5">
        <header className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold lowercase tracking-wide text-mist">quiet / archive</h2>
          <button onClick={onClose} className="font-mono text-[11px] text-mist-faint hover:text-mist">
            esc
          </button>
        </header>

        {active.length === 0 ? (
          <EmptyState>quiet things from any list — they land here</EmptyState>
        ) : (
          [...groups.entries()]
            .filter(([, list]) => list.length > 0)
            .map(([k, list]) => (
              <div key={k}>
                <SectionLabel>
                  {k} · {list.length}
                </SectionLabel>
                <ul>
                  {list.map((m) => (
                    <MuteEntry key={m.id} m={m} />
                  ))}
                </ul>
              </div>
            ))
        )}

        <div className="mt-6">
          <SectionLabel>quiet something</SectionLabel>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div>
              <label className={LABEL} htmlFor="mute-kind">
                kind
              </label>
              <select id="mute-kind" className={FIELD} value={kind} onChange={(e) => setKind(e.target.value as MuteKind)}>
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.kind}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="mute-target">
                target
              </label>
              <input
                id="mute-target"
                className={`${FIELD} font-mono`}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={KINDS.find((k) => k.kind === kind)?.placeholder}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="mute-duration">
                for
              </label>
              <select
                id="mute-duration"
                className={FIELD}
                value={duration}
                onChange={(e) => setDuration(e.target.value as Duration)}
              >
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-mist-dim">
              <input
                type="checkbox"
                checked={enforce}
                onChange={(e) => setEnforce(e.target.checked)}
                className="accent-amber"
              />
              actually pause the source
            </label>
            <button
              type="submit"
              disabled={busy || target.trim() === ''}
              className="w-full rounded-lg bg-amber/15 py-1.5 font-mono text-sm text-amber transition-colors hover:bg-amber/25 disabled:opacity-40"
            >
              {busy ? '…' : 'quiet it'}
            </button>
            {error && <div className="truncate font-mono text-xs text-coral" title={error}>{error}</div>}
          </form>
        </div>
      </aside>
    </>
  );
}
