import { useEffect, useRef, useState } from 'react';
import type { Snapshot, Mute, MuteKind } from '../../../shared/types';
import { addMute, removeMute } from '../api';
import { useScrollLock } from '../hooks';
import { SectionLabel, EmptyState, CopyText, RelTime } from './ui';

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
  { kind: 'flag-source', placeholder: 'system' },
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

/** Flip an until-activity quiet into a forever one (re-add without the flag). */
function KeepQuietButton({ m }: { m: Mute }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  return (
    <button
      type="button"
      disabled={state === 'busy'}
      title="stop watching — keep this quiet even when it gets new activity"
      onClick={async () => {
        setState('busy');
        try {
          await addMute({ kind: m.kind, target: m.target, until: m.until });
          setState('idle');
        } catch {
          setState('failed');
          setTimeout(() => setState('idle'), 4000);
        }
      }}
      className={`shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        state === 'failed' ? 'text-coral' : 'text-mist-faint hover:text-mist'
      }`}
    >
      {state === 'busy' ? '…' : state === 'failed' ? 'failed' : 'forever'}
    </button>
  );
}

function MuteEntry({ m }: { m: Mute }) {
  return (
    <li className="flex items-center gap-2 rounded border-b px-1 py-2 transition-colors last:border-b-0 hairline hover:bg-white/[0.03]">
      <div className="min-w-0 flex-1">
        <CopyText text={m.target} className="block w-full">
          <span className="block truncate text-sm text-mist">{m.target}</span>
        </CopyText>
        <div className="flex items-baseline gap-2">
          {m.enforcedBy && (
            <span className="truncate font-mono text-[10px] text-mist-faint" title={m.enforcedBy}>
              {m.enforcedBy}
            </span>
          )}
          <RelTime iso={m.createdAt} />
        </div>
      </div>
      {m.untilActivity ? (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] bg-white/5 text-mist-faint"
          title="quiet until new activity — a comment or push brings it back"
        >
          til activity
        </span>
      ) : (
        <Until iso={m.until} />
      )}
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
          m.mode === 'enforced' ? 'bg-amber/15 text-amber' : 'bg-white/5 text-mist-faint'
        }`}
      >
        {m.mode === 'enforced' ? 'enforced' : 'ui'}
      </span>
      {m.untilActivity && <KeepQuietButton m={m} />}
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
  const panelRef = useRef<HTMLElement>(null);

  // esc is handled centrally in App (topmost overlay first) — no window listener here.
  // move focus into the drawer on open (esc/tab work without a click) + body scroll lock
  useScrollLock();
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

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
      {/* backdrop — click closes; the aside is a sibling, so panel clicks never reach this */}
      <div className="backdrop-fade fixed inset-0 z-40 bg-ink/60" onClick={onClose} />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Quiet archive"
        className="glass-raised slide-in-right fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col overflow-y-auto p-5 outline-none sm:w-96"
      >
        <header className="mb-4 flex items-baseline justify-between border-b pb-3 hairline">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber">Workspace</div>
            <h2 className="mt-1 text-lg font-semibold text-mist">Quiet archive</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="close (esc)"
            className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[11px] text-mist-faint transition-colors hover:text-mist"
          >
            close
          </button>
        </header>

        {active.length === 0 ? (
          <EmptyState>Items you quiet will stay here until you bring them back.</EmptyState>
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
          <SectionLabel>Quiet something else</SectionLabel>
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
