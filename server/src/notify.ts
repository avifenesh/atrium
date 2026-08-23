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
const HOUR_MS = 3_600_000;
const MAX_LEN = 300;

// RATE LIMITS, SPLIT BY SEVERITY (owner ruling, 2026-08-23).
//
// There was one `GLOBAL_CAP = 5` for everything, and on a fleet-wide outage it INVERTED its
// own intent: the sixth crit — a second box going down — was silently dropped from the phone.
// A cap exists to stop spam, and the alert sources now sit behind their own escalation
// ladders (the serving sentinel re-pages a persisting condition 17 times a day, not 1,440),
// so the anti-spam job is already done upstream. A cap doing an already-done job while
// suppressing the one page that matters is a bad trade.
//
// So crit gets its own, much higher ceiling, and the counters are INDEPENDENT rather than one
// shared budget. That second part is load-bearing: the serving sentinel raises `edge-down` as
// a WARN on the first tick and escalates to crit on the fifth, so a fleet-wide outage produces
// a burst of warns *before* the crits. A shared budget would let those warns eat the crit
// allowance and starve exactly the pages this change exists to deliver.
const SOFT_CAP = 5; // warn + info per rolling hour — unchanged; these are not worth a storm
const HARD_CAP = 20; // crit per rolling hour — a real ceiling, so a runaway writer cannot flood

let opts: NotifyOpts | null = null; // null until init — pre-init flag updates are dropped
let lastPingAt = new Map<string, number>(); // flag id → last send attempt
let pinged = new Map<string, Flag['severity']>(); // pinged and still raised → drives clear notices
let critSentAt: number[] = []; // crit attempt timestamps inside the rolling window
let softSentAt: number[] = []; // warn/info attempt timestamps inside the rolling window
let chain: Promise<void> = Promise.resolve(); // serializes sends; flush() awaits it

export function init(o: NotifyOpts): void {
  if (!(o.minSeverity in SEV_RANK)) {
    // unknown rank would make both severity comparisons false → filter silently off
    console.error(`notify: unknown minSeverity ${JSON.stringify(o.minSeverity)}, defaulting to crit`);
    o = { ...o, minSeverity: 'crit' };
  }
  opts = o;
  lastPingAt = new Map();
  pinged = new Map();
  critSentAt = [];
  softSentAt = [];
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
    pinged.set(f.id, f.severity);
    enqueue(format(f), now, f.severity);
  }

  for (const [id, severity] of pinged) {
    if (nextIds.has(id)) continue;
    pinged.delete(id);
    const old = prev.find((f) => f.id === id);
    if (opts.notifyClear && old && !isMuted(id, activeMutes, now)) {
      // The clear inherits the severity of the flag it closes, so it rides the same ceiling
      // as the page it answers. Under the old single cap, six crits plus five clears left one
      // page the owner could never close — which is the failure the clear notice exists to
      // prevent in the first place.
      enqueue(`atrium [clear] ${clean(old.title)}`.slice(0, MAX_LEN), now, severity);
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

function enqueue(msg: string, now: number, severity: Flag['severity']): void {
  const crit = severity === 'crit';
  const window = (crit ? critSentAt : softSentAt).filter((t) => now - t < HOUR_MS);
  if (crit) critSentAt = window;
  else softSentAt = window;
  const cap = crit ? HARD_CAP : SOFT_CAP;
  if (window.length >= cap) {
    // Dropped, not queued — the flags view and the CRM still show it. Logged rather than
    // silent: a page that never went out must leave a trace somewhere, or hitting the ceiling
    // looks exactly like nothing having happened.
    console.error(`[notify] ${severity} send DROPPED at the ${cap}/hr ceiling: ${msg.slice(0, 120)}`);
    return;
  }
  window.push(now);
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
