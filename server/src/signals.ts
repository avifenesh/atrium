// Signals hub — one surface for "the outside world noticed my work".
//
// Three feeders (mentions, radar, exposure) used to write three unrelated shapes
// into the generic plugin lane, with their watch lists hardcoded in three different
// files. This module gives them one typed section, one editable watch file, and one
// "new since I last looked" clock:
//
//   ~/.config/atrium/signals.json
//     { watch: { terms, radarWatch, demandKeywords }, lastReviewedAt, seen: {id: iso} }
//
// - `watch` is runtime-editable from the UI (PUT /api/signals/watch); collectors read
//   it on every poll, so changing a term or a watched family needs no code, no restart.
//   scripts/mention-radar.py reads the same file for its terms.
// - `seen` stamps the first time atrium saw each signal id; everything first seen
//   after `lastReviewedAt` renders as NEW, and "mark reviewed" advances the clock.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { store } from './state.js';
import { iso, readJson } from './util.js';
import type {
  SignalItem,
  SignalLead,
  SignalLeadStatus,
  SignalsSourceStatus,
  SignalsState,
  SignalsWatch,
} from '../../shared/types.js';

const FILE = join(config.configDir, 'signals.json');
const SEEN_CAP = 4000;

/** mirrors scripts/mention-radar.py's builtin list — the seed for a fresh file so
 *  the UI shows the real terms instead of an empty editor */
const DEFAULT_TERMS = [
  'agnix', 'revuto', 'memra', 'bw24', 'agentsys', 'ferrings', 'glide-mq', 'glidemq',
  'computer-use-linux', 'agent-workspace-linux', 'valkey-skills', 'ocaml-valkey',
  'agent-sh', 'avifenesh',
];

interface PersistedSignals {
  watch: SignalsWatch;
  lastReviewedAt: string | null;
  seen: Record<string, string>;
  /** lead lifecycle by signal id — engaged (commented) / dismissed */
  leads: Record<string, SignalLead>;
}

function defaultWatch(): SignalsWatch {
  const radar = (config as unknown as { radar?: { watch?: SignalsWatch['radarWatch']; demandKeywords?: string[] } }).radar ?? {};
  return {
    terms: DEFAULT_TERMS,
    radarWatch: Array.isArray(radar.watch) ? radar.watch : [],
    demandKeywords: Array.isArray(radar.demandKeywords) && radar.demandKeywords.length
      ? radar.demandKeywords
      : ['gguf', 'nvfp4', 'fp8', 'quant', 'mtp', 'speculative', 'draft', 'blackwell', '5090'],
    // buyer-pain vocabulary: someone failing to run/serve the model is a prospect
    // for hosted inference, not a quant request — kept separate so the UI can rank
    // prospects above artifact demand
    prospectKeywords: [
      'api', 'endpoint', 'host', 'serve', 'serving', 'provider', 'oom', 'out of memory',
      'vram', 'watchdog', 'sigabrt', 'crash', 'too slow', 'tok/s', 'openrouter', 'inference',
    ],
    // self-hoster tells: naming your local runtime disqualifies the thread as a
    // lead (owner, 2026-08-23). Downloaders talk runtimes; buyers talk providers.
    disqualifyKeywords: [
      'vllm', 'llama.cpp', 'llamacpp', 'ollama', 'lm studio', 'lmstudio', 'sglang',
      'exllama', 'koboldcpp', 'text-generation-webui', 'tabbyapi', 'mlx', 'gguf',
      'my rig', 'my gpu', 'home server', 'self-host', 'self host', 'run locally', 'running locally',
    ],
    // standalone buyer-pain searches (researched 2026-08-23): the query itself
    // qualifies a hit — these are the phrases the two buyer profiles type when
    // they are in provider-shopping pain, family name not required.
    buyerQueries: [
      'openrouter alternative',
      'openrouter markup',
      'inference costs production',
      'rate limited anthropic',
      'rate limited openai',
      'llm api bill',
      'cheaper api agents',
      'claude code weekly cap',
      'openclaw cheaper',
      'opencode provider',
      'openai_api_base',
      'agent api costs',
    ],
    // seeds mirror the retired darklanes snapshot constants — the business
    // portfolio lives here now, edited from the UI like everything else
    repos: ['avifenesh/memra'],
    // `Author/*` enumerates the whole account at read time (expandHfModels) —
    // the fixed two-id seed sat blind to 18 published cards and one renamed id.
    hfModels: ['tiyuvta/*', 'Avifenesh/*'],
    crates: ['memra-server', 'memra-engine'],
  };
}

let persisted: PersistedSignals = { watch: defaultWatch(), lastReviewedAt: null, seen: {}, leads: {} };
let loaded = false;
const bySource = new Map<string, { items: SignalItem[]; status: SignalsSourceStatus }>();

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

async function persist(): Promise<void> {
  try {
    await mkdir(config.configDir, { recursive: true });
    await atomicWrite(FILE, JSON.stringify(persisted, null, 2));
  } catch (err) {
    console.error('[signals] persist failed:', err instanceof Error ? err.message : err);
  }
}

function assemble(): SignalsState {
  const items = [...bySource.values()].flatMap((s) => {
    return s.items.map((item) => {
      const lead = persisted.leads[item.id];
      return lead ? { ...item, lead } : item;
    });
  });
  items.sort((a, b) => (b.occurredAt ?? b.firstSeenAt).localeCompare(a.occurredAt ?? a.firstSeenAt));
  const sources = [...bySource.values()].map((s) => s.status);
  return {
    updatedAt: sources.some((s) => s.updatedAt) ? iso() : null,
    items,
    watch: persisted.watch,
    lastReviewedAt: persisted.lastReviewedAt,
    sources,
    error: sources.map((s) => s.error).filter(Boolean).join(' | ') || null,
  };
}

function emit(): void {
  store.setSection('signals', assemble());
}

export const signals = {
  async load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const saved = await readJson<Partial<PersistedSignals>>(FILE);
    if (saved && typeof saved === 'object') {
      const w = saved.watch;
      const def = defaultWatch();
      persisted = {
        watch: {
          terms: Array.isArray(w?.terms) ? w.terms : def.terms,
          radarWatch: Array.isArray(w?.radarWatch) ? w.radarWatch : def.radarWatch,
          demandKeywords: Array.isArray(w?.demandKeywords) ? w.demandKeywords : def.demandKeywords,
          prospectKeywords: Array.isArray(w?.prospectKeywords) ? w.prospectKeywords : def.prospectKeywords,
          disqualifyKeywords: Array.isArray(w?.disqualifyKeywords) ? w.disqualifyKeywords : def.disqualifyKeywords,
          buyerQueries: Array.isArray(w?.buyerQueries) ? w.buyerQueries : def.buyerQueries,
          repos: Array.isArray(w?.repos) ? w.repos : def.repos,
          hfModels: Array.isArray(w?.hfModels) ? w.hfModels : def.hfModels,
          crates: Array.isArray(w?.crates) ? w.crates : def.crates,
        },
        lastReviewedAt: typeof saved.lastReviewedAt === 'string' ? saved.lastReviewedAt : null,
        seen: saved.seen && typeof saved.seen === 'object' ? (saved.seen as Record<string, string>) : {},
        leads: saved.leads && typeof saved.leads === 'object' ? (saved.leads as Record<string, SignalLead>) : {},
      };
    } else {
      await persist(); // seed the file so the terms are editable from day one
    }
    emit();
  },

  watch(): SignalsWatch {
    return persisted.watch;
  },

  /** Replace the watch config (partial: only provided arrays change). */
  async setWatch(patch: Partial<SignalsWatch>): Promise<SignalsWatch> {
    const next: SignalsWatch = { ...persisted.watch };
    if (patch.terms !== undefined) {
      if (!Array.isArray(patch.terms) || patch.terms.some((t) => typeof t !== 'string')) {
        throw new Error('terms must be an array of strings');
      }
      next.terms = patch.terms.map((t) => t.trim()).filter(Boolean);
    }
    if (patch.demandKeywords !== undefined) {
      if (!Array.isArray(patch.demandKeywords) || patch.demandKeywords.some((t) => typeof t !== 'string')) {
        throw new Error('demandKeywords must be an array of strings');
      }
      next.demandKeywords = patch.demandKeywords.map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
    if (patch.prospectKeywords !== undefined) {
      if (!Array.isArray(patch.prospectKeywords) || patch.prospectKeywords.some((t) => typeof t !== 'string')) {
        throw new Error('prospectKeywords must be an array of strings');
      }
      next.prospectKeywords = patch.prospectKeywords.map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
    if (patch.radarWatch !== undefined) {
      if (!Array.isArray(patch.radarWatch) || patch.radarWatch.some((e) => !e || typeof e.family !== 'string' || typeof e.org !== 'string')) {
        throw new Error('radarWatch entries need at least { family, org }');
      }
      next.radarWatch = patch.radarWatch;
    }
    for (const key of ['repos', 'hfModels', 'crates'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
        throw new Error(`${key} must be an array of strings`);
      }
      next[key] = value.map((t) => t.trim()).filter(Boolean);
    }
    persisted.watch = next;
    await persist();
    emit();
    return next;
  },

  /** Lead state for one signal id — untouched signals return undefined. */
  lead(id: string): SignalLead | undefined {
    return persisted.leads[id];
  },

  /** Record what happened with a lead (engaged = commented/answered, dismissed =
   *  not worth it); null status clears it back to untouched. */
  async setLead(id: string, status: SignalLeadStatus | null, note?: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('missing signal id');
    if (status === null) {
      delete persisted.leads[id];
    } else {
      if (status !== 'engaged' && status !== 'dismissed') throw new Error(`invalid lead status: ${status}`);
      persisted.leads[id] = { status, note: note?.trim() || null, updatedAt: iso() };
    }
    // retire lead records whose signal is long gone from every feed — the file
    // holds decisions about live leads, not a graveyard
    const liveIds = new Set([...bySource.values()].flatMap((s) => s.items.map((i) => i.id)));
    const cutoff = Date.now() - 90 * 86_400_000;
    for (const [key, lead] of Object.entries(persisted.leads)) {
      if (!liveIds.has(key) && new Date(lead.updatedAt).getTime() < cutoff) delete persisted.leads[key];
    }
    await persist();
    emit();
  },

  async markReviewed(): Promise<string> {
    persisted.lastReviewedAt = iso();
    await persist();
    emit();
    return persisted.lastReviewedAt;
  },

  /** A feeder hands over its current view; firstSeenAt is assigned here so "new"
   *  means new-to-atrium, not new-to-this-poll. */
  async publish(sourceId: string, items: Array<Omit<SignalItem, 'firstSeenAt'>>, error: string | null): Promise<void> {
    const now = iso();
    let seenChanged = false;
    const stamped: SignalItem[] = items.map((item) => {
      let first = persisted.seen[item.id];
      if (!first) {
        first = now;
        persisted.seen[item.id] = now;
        seenChanged = true;
      }
      return { ...item, firstSeenAt: first };
    });
    bySource.set(sourceId, {
      items: stamped,
      status: { id: sourceId, updatedAt: now, error },
    });
    if (seenChanged) {
      // cap the registry — oldest stamps go first; an id that ever resurfaces is
      // simply "new" again, which is the honest reading after that long
      const entries = Object.entries(persisted.seen);
      if (entries.length > SEEN_CAP) {
        entries.sort((a, b) => a[1].localeCompare(b[1]));
        persisted.seen = Object.fromEntries(entries.slice(entries.length - SEEN_CAP));
      }
      await persist();
    }
    emit();
  },
};
