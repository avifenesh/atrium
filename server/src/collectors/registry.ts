/** Collector contract: each collector module default-exports one of these.
 * The registry schedules them, isolates failures, and supports forced refresh. */
export interface Collector {
  name: string; // matches a SectionName, or a custom name for multi-section collectors
  intervalMs: number;
  /** Runs one poll cycle. Writes results into the store itself (store.setSection / store.setFlags). */
  run(): Promise<void>;
}

const collectors = new Map<string, { c: Collector; timer: NodeJS.Timeout | null; running: boolean }>();

export function register(c: Collector): void {
  if (collectors.has(c.name)) throw new Error(`collector ${c.name} already registered`);
  collectors.set(c.name, { c, timer: null, running: false });
}

export async function runOnce(name: string): Promise<boolean> {
  const entry = collectors.get(name);
  if (!entry || entry.running) return false;
  entry.running = true;
  try {
    await entry.c.run();
  } catch (err) {
    console.error(`[collector:${name}]`, err instanceof Error ? err.message : err);
  } finally {
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
