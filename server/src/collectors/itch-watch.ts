import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Collector } from './registry.js';
import type { ItchState, ItchRunInfo, ItchResearch } from '../../../shared/types.js';

// no flags here — the agents collector owns the itch agent-card status; raising one too would double-report.

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function mapRun(r: any): ItchRunInfo {
  return {
    stem: str(r?.stem),
    nIdeas: num(r?.n_ideas),
    nRated: num(r?.n_rated),
    isCollide: !!r?.is_collide,
    collisionTemp: numOrNull(r?.collision_temp),
    sampledDomains: arr(r?.sampled_domains).filter((d) => typeof d === 'string'),
    baselineFor: strOrNull(r?.baseline_for),
  };
}

function mapResearch(s: any): ItchResearch {
  return {
    running: !!s?.running,
    started: strOrNull(s?.started),
    savedStem: strOrNull(s?.saved_stem),
    killedReason: strOrNull(s?.killed_reason),
  };
}

// updatedAt stays null — never-collected must not read as "last data <poll cadence> ago"
function emptyState(): ItchState {
  return {
    updatedAt: null, up: false, runs: [],
    research: { running: false, started: null, savedStem: null, killedReason: null },
    ratedTotal: null, error: null,
  };
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(config.itch.base + path, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

let lastGood: ItchState | null = null;
let lastStartAttempt = 0;

// itch has no systemd unit; the desktop launcher script starts the server and then opens a
// browser, which a daemon must not do — so spawn the server exactly as the launcher does,
// minus the browser (throttled, errors swallowed).
function tryStartItch(): void {
  const now = Date.now();
  if (now - lastStartAttempt < 600_000) return;
  lastStartAttempt = now;
  try {
    const child = spawn('python3', ['itch.py', '--ui', '--port', '8799', '--host', '127.0.0.1', '--no-browser'], {
      cwd: config.itch.repo,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {}); // spawn failures (python3/cwd missing) arrive async — unhandled they crash the daemon
    child.unref();
  } catch {
    /* best effort — next poll reports the failure either way */
  }
}

async function run(): Promise<void> {
  try {
    const [runsRaw, statusRaw] = await Promise.all([
      getJson('/api/runs'),
      getJson('/api/research/status'),
    ]);
    // decisions is a nice-to-have count — its failure alone must not fail the poll
    const ratedTotal = await getJson('/api/decisions')
      .then((d) => (Array.isArray(d) ? d.length : null))
      .catch(() => null);
    const state: ItchState = {
      updatedAt: iso(),
      up: true,
      runs: arr(runsRaw).map(mapRun),
      research: mapResearch(statusRaw),
      ratedTotal,
      error: null,
    };
    lastGood = state;
    store.setSection('itch', state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // keep lastGood's updatedAt so "last data" shows real staleness, not the poll cadence
    const state: ItchState = lastGood ? { ...lastGood } : emptyState();
    state.up = false;
    state.error = msg;
    store.setSection('itch', state);
    tryStartItch();
  }
}

const collector: Collector = { name: 'itch', intervalMs: config.poll.itchMs, run };
export default collector;
