import { config } from '../config.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import { loadItchJournal } from '../core/itch.js';
import { itchResearchStatus } from '../core/itch-research.js';
import type { Collector } from './registry.js';
import type { ItchState, ItchResearch } from '../../../shared/types.js';

// no flags here — the agents collector owns the itch agent-card status; raising one too would double-report.

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
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

let lastGood: ItchState | null = null;

async function run(): Promise<void> {
  try {
    const [journal, statusRaw] = await Promise.all([
      loadItchJournal(config.paths),
      Promise.resolve(itchResearchStatus()),
    ]);
    const state: ItchState = {
      updatedAt: iso(),
      up: true,
      runs: journal.runs,
      research: mapResearch(statusRaw),
      ratedTotal: journal.ratedTotal,
      error: null,
    };
    lastGood = state;
    store.setSection('itch', state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const journal = await loadItchJournal(config.paths).catch(() => null);
    // keep lastGood's updatedAt so "last data" shows real staleness, except when
    // Atrium successfully read the journal directly from disk (migrated core).
    const state: ItchState = lastGood ? { ...lastGood } : emptyState();
    if (journal) {
      state.updatedAt = iso();
      state.runs = journal.runs;
      state.ratedTotal = journal.ratedTotal;
    }
    state.up = false;
    state.error = msg;
    store.setSection('itch', state);
  }
}

const collector: Collector = { name: 'itch', intervalMs: config.poll.itchMs, run };
export default collector;
