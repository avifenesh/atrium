import { config } from '../config.js';

/** Collector contract: each collector module default-exports one of these.
 * The registry schedules them, isolates failures, and supports forced refresh. */
export interface Collector {
  name: string; // matches a SectionName, or a custom name for multi-section collectors
  intervalMs: number;
  /** Core collectors write a typed snapshot section via store.setSection. Plugin
   *  collectors (core:false, the default) write the generic `extra` lane via
   *  store.setExtra and render in the generic panel. */
  core?: boolean;
  /** Runs one poll cycle. Writes results into the store itself (store.setSection /
   *  store.setExtra / store.setFlags). */
  run(): Promise<void>;
}

const collectors = new Map<string, { c: Collector; timer: NodeJS.Timeout | null; running: boolean }>();

/** True when this collector name is switched off in config.collectors.disabled. */
export function isDisabled(name: string): boolean {
  // config.collectors.disabled is user-editable — guard against a malformed value
  return Array.isArray(config.collectors?.disabled) && config.collectors.disabled.includes(name);
}

export function register(c: Collector): void {
  if (collectors.has(c.name)) throw new Error(`collector ${c.name} already registered`);
  if (isDisabled(c.name)) {
    console.log(`[collector:${c.name}] disabled via config — not registered`);
    return;
  }
  collectors.set(c.name, { c, timer: null, running: false });
}

export async function runOnce(name: string): Promise<boolean> {
  const entry = collectors.get(name);
  if (!entry || entry.running) return false;
  entry.running = true;
  // watchdog: a hung run() would hold the latch forever and stop all future
  // polls; past the deadline we log and release it — the orphaned promise
  // settling later is harmless (setSection is idempotent)
  const deadlineMs = Math.max(entry.c.intervalMs * 2, 60_000);
  let watchdog: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    watchdog = setTimeout(() => resolve('timeout'), deadlineMs);
    watchdog.unref();
  });
  try {
    const outcome = await Promise.race([entry.c.run().then(() => 'done' as const), deadline]);
    if (outcome === 'timeout') console.error(`[${name}] run exceeded deadline`);
  } catch (err) {
    console.error(`[collector:${name}]`, err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(watchdog);
    entry.running = false;
  }
  return true;
}

export function startAll(): void {
  for (const [name, entry] of collectors) {
    void runOnce(name); // immediate first run
    entry.timer = setInterval(() => void runOnce(name), entry.c.intervalMs);
    entry.timer.unref();
  }
}

export function list(): string[] {
  return [...collectors.keys()];
}
