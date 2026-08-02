// crit-flag push notifications over hermes — atrium must alert even while unwatched.
// self-contained: index.ts calls init() once; state.ts calls onFlagsChanged() on every
// flag recompute. never throws into the store path; send failures only log.
import { execFile } from 'node:child_process';
import type { Flag, Mute } from '../../shared/types.js';

export interface NotifyOpts {
  enabled: boolean;
  minSeverity: Flag['severity'];
  /** one ping per flag id per window, even if the flag flaps */
  throttleMs: number;
  /** single-line notice when a previously-pinged flag disappears */
  notifyClear: boolean;
  /** argv array; message appended as the final arg — injectable so tests stub it, never shell */
  sendCmd: string[];
}

const SEV_RANK: Record<Flag['severity'], number> = { info: 0, warn: 1, crit: 2 };
const GLOBAL_CAP = 5; // sends per rolling hour — a flag storm must not become a phone storm
const HOUR_MS = 3_600_000;
const MAX_LEN = 300;

let opts: NotifyOpts | null = null; // null until init — pre-init flag updates are dropped
let lastPingAt = new Map<string, number>(); // flag id → last send attempt
let pinged = new Set<string>(); // pinged and still raised — drives clear notices
let sentAt: number[] = []; // attempt timestamps inside the rolling cap window
let chain: Promise<void> = Promise.resolve(); // serializes sends; flush() awaits it

export function init(o: NotifyOpts): void {
  if (!(o.minSeverity in SEV_RANK)) {
    // unknown rank would make both severity comparisons false → filter silently off
    console.error(`notify: unknown minSeverity ${JSON.stringify(o.minSeverity)}, defaulting to crit`);
    o = { ...o, minSeverity: 'crit' };
  }
  opts = o;
  lastPingAt = new Map();
  pinged = new Set();
  sentAt = [];
}

/** Store hook — called with the previous and next full flag lists on every recompute. */
export function onFlagsChanged(prev: Flag[], next: Flag[], activeMutes: Mute[]): void {
  if (!opts || !opts.enabled || opts.sendCmd.length === 0) return;
  const now = Date.now();
  const prevSev = new Map(prev.map((f) => [f.id, SEV_RANK[f.severity]]));
  const nextIds = new Set(next.map((f) => f.id));
  // expired throttle entries pruned each call — bounded memory across long uptimes
  for (const [id, t] of lastPingAt) if (now - t >= opts.throttleMs) lastPingAt.delete(id);

  for (const f of next) {
    // raise = new id OR escalation across minSeverity under a stable id (e.g. system:swap
    // warn→crit); presence-only gating would make the gradual-pressure crit unreachable
    const was = prevSev.get(f.id);
    if (was !== undefined && was >= SEV_RANK[opts.minSeverity]) continue;
    if (SEV_RANK[f.severity] < SEV_RANK[opts.minSeverity]) continue;
    if (isMuted(f.id, activeMutes, now)) continue;
    if (lastPingAt.has(f.id)) continue; // throttled flap (pruned above once the window passes)
    // recorded at attempt, not success — a hermes outage must not turn into a retry storm
    lastPingAt.set(f.id, now);
    pinged.add(f.id);
    enqueue(format(f), now);
  }

  for (const id of pinged) {
    if (nextIds.has(id)) continue;
    pinged.delete(id);
    const old = prev.find((f) => f.id === id);
    if (opts.notifyClear && old && !isMuted(id, activeMutes, now)) {
      enqueue(`atrium [clear] ${clean(old.title)}`.slice(0, MAX_LEN), now);
    }
  }
}

/** Test/shutdown hook: resolves once all queued sends have finished. */
export function flush(): Promise<void> {
  return chain;
}

function isMuted(flagId: string, mutes: Mute[], now: number): boolean {
  return mutes.some(
    (m) =>
      (m.until === null || new Date(m.until).getTime() > now) &&
      ((m.kind === 'flag' && m.target === flagId) ||
        // a source-level quiet (e.g. target "system") mutes every flag whose id is "system:…"
        (m.kind === 'flag-source' && flagId.startsWith(`${m.target}:`))),
  );
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function format(f: Flag): string {
  const msg = `atrium [${f.severity}] ${clean(f.title)} — ${clean(f.detail)}`;
  return msg.length <= MAX_LEN ? msg : `${msg.slice(0, MAX_LEN - 1)}…`;
}

function enqueue(msg: string, now: number): void {
  sentAt = sentAt.filter((t) => now - t < HOUR_MS);
  if (sentAt.length >= GLOBAL_CAP) return; // dropped, not queued — the flags view still shows it
  sentAt.push(now);
  const [cmd, ...args] = opts!.sendCmd;
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        execFile(cmd, [...args, msg], { timeout: 15_000 }, (err) => {
          if (err) console.error('[notify] send failed:', err.message);
          resolve();
        });
      }),
  );
}
