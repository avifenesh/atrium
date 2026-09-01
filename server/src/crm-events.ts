// CRM activity — the pipeline's memory of MOTION.
//
// The board answers "what is"; nothing answered "what changed since I last
// looked". A lead arriving, a signup, an account crossing into paying or going
// quiet, spend moving — each was visible only as a different current-state
// snapshot, so the owner diffed the board by memory. This module records those
// transitions once, as they happen, and serves them as a feed.
//
//   ~/.config/atrium/crm-events.jsonl        append-only ledger, one event per line
//   ~/.config/atrium/crm-events-state.json   diff baseline (survives restarts)
//
// The baseline is load-bearing: without it every daemon restart would re-emit
// the whole pipeline as "new". A missing baseline therefore SEEDS silently —
// the first observe() after first deploy records what exists and emits nothing.
//
// Events come from two directions: observe() diffs the assembled pipeline on a
// clock (arrivals, stage moves, quiet/resume, usage deltas), and emit() takes
// point-in-time facts the differ cannot see (a do launch, a logged contact, a
// near-miss the ingest gate dropped — the false negative that was invisible).

import { mkdir, appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { iso, readJson } from './util.js';
import type { CrmActivity, CrmEvent, CrmEventType, CrmItem, CrmStage } from '../../shared/types.js';

let ledgerFile = join(config.configDir, 'crm-events.jsonl');
let stateFile = join(config.configDir, 'crm-events-state.json');

/** In memory and served; the ledger file is compacted down to this too. */
const EVENT_CAP = 2000;
/** Rewrite the ledger once it carries this much dead weight past the cap. */
const COMPACT_AT = EVENT_CAP + 500;
/** Mirrors crm.ts QUIET_DAYS — an active/paying account silent this long is news. */
const QUIET_DAYS = 3;
/** One usage event per account per this window, so a busy customer is a line an hour, not a line a poll. */
const USAGE_COALESCE_MS = 3_600_000;
/** Usage deltas smaller than this wait for the next window instead of printing noise. */
const USAGE_MIN_REQUESTS = 1;

interface ItemBaseline {
  kind: CrmItem['kind'];
  stage: CrmStage;
  requests: number | null;
  spentMicro: number | null;
  lastActiveDay: string | null;
  /** whether the account was already past the quiet threshold at last observe */
  quiet: boolean;
}

interface PersistedState {
  seededAt: string | null;
  items: Record<string, ItemBaseline>;
  /** per-account: when the last usage event fired and the counters it reported up to */
  usage: Record<string, { at: string; requests: number; spentMicro: number }>;
}

let events: CrmEvent[] = [];
let state: PersistedState = { seededAt: null, items: {}, usage: {} };
let loaded = false;
let ledgerLines = 0;
/** Appends chain here so concurrent emits never interleave lines. */
let ledgerQueue: Promise<void> = Promise.resolve();

async function persistState(): Promise<void> {
  try {
    await mkdir(config.configDir, { recursive: true });
    const tmp = `${stateFile}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, stateFile);
  } catch (err) {
    console.error('[crm-events] state persist failed:', err instanceof Error ? err.message : err);
  }
}

async function appendLedger(event: CrmEvent): Promise<void> {
  try {
    await mkdir(config.configDir, { recursive: true });
    await appendFile(ledgerFile, `${JSON.stringify(event)}\n`, 'utf8');
    ledgerLines += 1;
    if (ledgerLines > COMPACT_AT) {
      // rewrite from memory (already capped) so the file never grows unbounded
      const tmp = `${ledgerFile}.tmp-${process.pid}`;
      await writeFile(tmp, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      await rename(tmp, ledgerFile);
      ledgerLines = events.length;
    }
  } catch (err) {
    console.error('[crm-events] ledger append failed:', err instanceof Error ? err.message : err);
  }
}

function validEvent(raw: unknown): CrmEvent | null {
  const e = raw as Partial<CrmEvent> | null;
  if (!e || typeof e.at !== 'string' || typeof e.type !== 'string' || typeof e.title !== 'string') return null;
  return {
    at: e.at,
    type: e.type as CrmEventType,
    itemId: typeof e.itemId === 'string' ? e.itemId : null,
    title: e.title.slice(0, 300),
    detail: typeof e.detail === 'string' ? e.detail.slice(0, 500) : null,
    url: typeof e.url === 'string' ? e.url : null,
  };
}

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** The stage a `stage-change` title moved TO. The title is written as
 *  `<subject>: <from> → <to>`, and the arrow cannot occur in an address or a
 *  stage name, so the tail after the last arrow is the destination. */
function stageMovedTo(title: string): string | null {
  const parts = title.split(' → ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : null;
}

/**
 * Money an `account-usage` title claims, in cents of print. Two title shapes
 * exist and both have to read the same way: rows written before this classifier
 * printed `+$0.00` for a true zero AND for any sub-cent debit, and rows written
 * after it omit the money clause entirely when it would round to nothing.
 */
function usageClaimsMoney(title: string): boolean {
  const hit = title.match(/\+\$(\d+(?:\.\d+)?)/u);
  return hit ? Number(hit[1]) > 0 : false;
}

/**
 * Does this row carry a decision, or is it mechanism?
 *
 * The feed's default view shows signal only. Three shapes are mechanism:
 *
 *  - a near miss, which the ingest gate emits as a rescuable diagnostic and
 *    which its own producer marks as never a board row;
 *  - a usage delta with no money in it, which is a request counter ticking, and
 *    which the burst of plus-tagged signups printed once per account per hour;
 *  - an ACCOUNT stage move that is not into `paying`, because every other
 *    account stage is derived arithmetic: `signed-up → active` is the request
 *    counter crossing 1 (the usage row already said it), `→ lost` is the owner's
 *    own suspension echoing back (the security page counts those), and anything
 *    touching `new` is the orphan-baseline flap, a stage a live account cannot
 *    hold. Lead and direction stage moves stay: those the owner makes by hand.
 *
 * Nothing is dropped from the payload. This only sets the flag the view filters
 * on, and the view has a toggle that shows everything.
 */
export function eventSignal(e: CrmEvent): boolean {
  if (e.type === 'near-miss') return false;
  if (e.type === 'account-usage') return usageClaimsMoney(e.title);
  if (e.type === 'stage-change' && e.itemId?.startsWith('tenant:')) {
    return stageMovedTo(e.title) === 'paying';
  }
  return true;
}

function daysSilent(lastActiveDay: string | null, now: string): number | null {
  if (!lastActiveDay) return null;
  const days = Math.floor((Date.parse(now.slice(0, 10)) - Date.parse(lastActiveDay)) / 86_400_000);
  return Number.isNaN(days) ? null : days;
}

function baselineOf(item: CrmItem, now: string): ItemBaseline {
  const silent = daysSilent(item.metrics?.lastActiveDay ?? null, now);
  return {
    kind: item.kind,
    stage: item.stage,
    requests: item.metrics?.requests ?? null,
    spentMicro: item.metrics?.spentMicro ?? null,
    lastActiveDay: item.metrics?.lastActiveDay ?? null,
    quiet: (item.stage === 'active' || item.stage === 'paying') && silent != null && silent >= QUIET_DAYS,
  };
}

function arrivalEvent(item: CrmItem, now: string): CrmEvent {
  if (item.kind === 'account') {
    return {
      at: now,
      type: 'account-new',
      itemId: item.id,
      title: `signup: ${item.title}`,
      detail: item.metrics?.signupRef ? `via ${item.metrics.signupRef}` : null,
      url: null,
    };
  }
  if (item.kind === 'direction') {
    return { at: now, type: 'direction-new', itemId: item.id, title: item.title, detail: item.subtitle, url: item.url };
  }
  const rel = item.relevance;
  return {
    at: now,
    type: 'lead-new',
    itemId: item.id,
    title: item.title,
    detail: [
      item.source,
      rel ? `score ${rel.score}${rel.labels.length ? ` — ${rel.labels.join(', ')}` : ''}` : null,
    ].filter(Boolean).join(' · ') || null,
    url: item.url,
  };
}

export const crmEvents = {
  async load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const saved = await readJson<Partial<PersistedState>>(stateFile);
    if (saved && typeof saved === 'object') {
      state = {
        seededAt: typeof saved.seededAt === 'string' ? saved.seededAt : null,
        items: saved.items && typeof saved.items === 'object' ? saved.items as PersistedState['items'] : {},
        usage: saved.usage && typeof saved.usage === 'object' ? saved.usage as PersistedState['usage'] : {},
      };
    }
    try {
      const raw = await readFile(ledgerFile, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      ledgerLines = lines.length;
      events = lines
        .map((line) => {
          try {
            return validEvent(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter((e): e is CrmEvent => e !== null)
        .slice(-EVENT_CAP);
    } catch {
      events = []; // no ledger yet — first deploy, not an error
      ledgerLines = 0;
    }
  },

  /** Record one event now. Fire-and-forget on the file so callers stay fast. */
  emit(event: Omit<CrmEvent, 'at'> & { at?: string }): CrmEvent {
    const full: CrmEvent = {
      at: event.at ?? iso(),
      type: event.type,
      itemId: event.itemId ?? null,
      title: event.title.slice(0, 300),
      detail: event.detail?.slice(0, 500) ?? null,
      url: event.url ?? null,
    };
    events = [...events, full].slice(-EVENT_CAP);
    ledgerQueue = ledgerQueue.then(() => appendLedger(full));
    return full;
  },

  /** Wait for queued ledger writes — observe() and tests use it; emit callers need not. */
  flush(): Promise<void> {
    return ledgerQueue;
  },

  /** Diff the assembled pipeline against the persisted baseline and record what moved. */
  async observe(items: CrmItem[]): Promise<CrmEvent[]> {
    const now = iso();
    const emitted: CrmEvent[] = [];

    // First run ever: seed silently, or every existing row becomes "new" at once.
    if (state.seededAt === null) {
      for (const item of items) state.items[item.id] = baselineOf(item, now);
      state.seededAt = now;
      await persistState();
      console.error(`[crm-events] baseline seeded: ${items.length} items, no events emitted`);
      return emitted;
    }

    for (const item of items) {
      const prev = state.items[item.id];
      const next = baselineOf(item, now);

      if (!prev) {
        emitted.push(this.emit(arrivalEvent(item, now)));
        state.items[item.id] = next;
        continue;
      }

      if (prev.stage !== item.stage) {
        emitted.push(this.emit({
          type: 'stage-change',
          itemId: item.id,
          title: `${item.title}: ${prev.stage} → ${item.stage}`,
          detail: item.overridden ? 'pinned by owner' : `${item.kind} · derived from sources`,
          url: item.url,
        }));
      }

      if (item.kind === 'account' && item.metrics) {
        if (!prev.quiet && next.quiet) {
          const silent = daysSilent(item.metrics.lastActiveDay, now);
          emitted.push(this.emit({
            type: 'account-quiet',
            itemId: item.id,
            title: `gone quiet: ${item.title}`,
            detail: `${item.stage} account — last active ${item.metrics.lastActiveDay} (${silent}d ago)`,
            url: null,
          }));
        } else if (prev.quiet && !next.quiet) {
          emitted.push(this.emit({
            type: 'account-resumed',
            itemId: item.id,
            title: `back: ${item.title}`,
            detail: `active again after going quiet — last active ${item.metrics.lastActiveDay}`,
            url: null,
          }));
        }

        // usage delta, coalesced: measure against the counters the LAST EVENT
        // reported, not the last poll, so an hour of traffic prints once with
        // its full sum instead of twelve fragments.
        const anchor = state.usage[item.id] ?? {
          at: state.seededAt ?? now,
          requests: prev.requests ?? 0,
          spentMicro: prev.spentMicro ?? 0,
        };
        const dReq = (item.metrics.requests ?? 0) - anchor.requests;
        const dSpend = (item.metrics.spentMicro ?? 0) - anchor.spentMicro;
        const windowOpen = Date.parse(now) - Date.parse(anchor.at) >= USAGE_COALESCE_MS;
        if (windowOpen && (dReq >= USAGE_MIN_REQUESTS || dSpend > 0)) {
          // `+$0.00` was a lie in two directions at once: it printed for a true
          // zero and for any sub-cent debit, and it read as "money moved" in a
          // feed where money moving is the whole point. A delta under one cent
          // now prints requests only, and the detail line still carries the
          // lifetime spend, so nothing is lost.
          const spendClause = dSpend >= 10_000 ? ` · +${money(dSpend)}` : '';
          emitted.push(this.emit({
            type: 'account-usage',
            itemId: item.id,
            title: `${item.title}: +${dReq} req${spendClause}`,
            detail: `now ${item.metrics.requests} req lifetime · ${money(item.metrics.spentMicro)} spent`,
            url: null,
          }));
          state.usage[item.id] = { at: now, requests: item.metrics.requests, spentMicro: item.metrics.spentMicro };
        }
      }

      state.items[item.id] = next;
    }

    // Rows that vanished stay in the baseline map so a signal aging out of the
    // feeds and coming back a week later does not re-announce itself as new.
    // Persist every pass: counters in the baselines move even when no event fires.
    await persistState();
    await this.flush();
    return emitted;
  },

  /** Has this (type, itemId) already been recorded? Backed by the loaded ledger,
   *  so dedup survives restarts as far as the event cap reaches. */
  seen(type: CrmEventType, itemId: string): boolean {
    return events.some((e) => e.type === type && e.itemId === itemId);
  },

  activity(days = 7): CrmActivity {
    const now = iso();
    const cutoff = Date.parse(now) - days * 86_400_000;
    // The signal flag is attached here rather than at emit time: the ledger is
    // append-only, so a rule that lived in the written row could never be
    // corrected for the 200-odd rows already on disk.
    const windowed = events
      .filter((e) => Date.parse(e.at) >= cutoff)
      .reverse()
      .map((e) => ({ ...e, signal: eventSignal(e) }));
    const today: Partial<Record<CrmEventType, number>> = {};
    const todaySignal: Partial<Record<CrmEventType, number>> = {};
    const day = now.slice(0, 10);
    for (const e of events) {
      if (e.at.slice(0, 10) !== day) continue;
      today[e.type] = (today[e.type] ?? 0) + 1;
      if (eventSignal(e)) todaySignal[e.type] = (todaySignal[e.type] ?? 0) + 1;
    }
    return { updatedAt: now, events: windowed, today, todaySignal };
  },

  /** test hook: reset and redirect files */
  _resetForTest(dir?: string): void {
    events = [];
    state = { seededAt: null, items: {}, usage: {} };
    loaded = false; // so a test can exercise load() against its own dir
    ledgerLines = 0;
    ledgerQueue = Promise.resolve();
    if (dir) {
      ledgerFile = join(dir, 'crm-events.jsonl');
      stateFile = join(dir, 'crm-events-state.json');
    }
  },
};
