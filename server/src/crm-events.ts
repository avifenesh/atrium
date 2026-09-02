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
import { stageMovedFrom, stageMovedTo } from '../../shared/crm-feed.js';
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

/** The detail stamp observe() writes when the stage came from the owner's own
 *  hand rather than from the sources. It is the only record that a move was a
 *  decision, so the classifier has to read it. */
const OWNER_PINNED = 'pinned by owner';

/** Account stages that mean money or traffic already happened: `paying` is a
 *  purchase, and `active` is the console's own requests-above-one. A `signed-up`
 *  account never called, which is the shape of every row in a farm sweep. */
const PAID_OR_TRAFFICKED = new Set(['paying', 'active']);

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
 * The money floor's twin, in requests.
 *
 * A money-only quiet rule hides the abuse shape we have actually been hit by:
 * volume without dollars. The 2026-08-31 ring drained credit across 26 accounts,
 * and at roughly $0.0001 a request an account can serve hundreds an hour while
 * every window's debit rounds under the one-cent print floor, so `+$0.00` (or no
 * money clause at all) is what a busy attacker looks like. The fan-out defect
 * makes it worse: credit is replicated per serving box and spend is not
 * aggregated, so each box's share of the same traffic rounds smaller still.
 *
 * 100 requests is the same bar as the money floor rather than a new opinion: at
 * list prices that is about a cent of traffic, so a window trips this exactly
 * when it would have tripped the dollar test had the spend been counted whole.
 */
const REQUEST_FLOOR = 100;

function usageClaimsVolume(title: string): boolean {
  const hit = title.match(/\+(\d+) req/u);
  return hit ? Number(hit[1]) >= REQUEST_FLOOR : false;
}

/**
 * What a row's neighbours in the same view say about it.
 *
 * Two of the quiet rules are about DUPLICATION rather than shape, and duplication
 * is only visible across the window: a lead skipped minutes after its own arrival
 * row prints "it came in" and "you already closed it" as two lines, and the stage
 * write crm.ts makes when a contact is logged is already reported by the
 * contact-logged row itself.
 */
export interface SignalContext {
  /** items whose arrival row is inside the same view, by the UTC day it landed on */
  arrivals: Map<string, string>;
  /** items with a logged touch inside the same view, by the UTC day of the touch */
  contacted: Map<string, string>;
}

const ARRIVAL_TYPES = new Set<CrmEventType>(['lead-new', 'direction-new', 'account-new']);

export function signalContext(windowed: CrmEvent[]): SignalContext {
  const ctx: SignalContext = { arrivals: new Map(), contacted: new Map() };
  for (const e of windowed) {
    if (!e.itemId) continue;
    if (ARRIVAL_TYPES.has(e.type)) ctx.arrivals.set(e.itemId, e.at.slice(0, 10));
    if (e.type === 'contact-logged') ctx.contacted.set(e.itemId, e.at.slice(0, 10));
  }
  return ctx;
}

/** The feed is grouped by UTC day, so "already on screen next to it" means the
 *  same group. A decision the owner made hours later, in a different group, is
 *  the only row that day holds about the item: suppressing it there loses the
 *  owner's own work instead of deduplicating it. */
function sameDayGroup(at: string, other: string | undefined): boolean {
  return other != null && at.slice(0, 10) === other;
}

/**
 * Does this row carry a decision, or is it mechanism?
 *
 * The feed's default view shows signal only. What is mechanism:
 *
 *  - a usage delta with no money in it, which is a request counter ticking, and
 *    which the burst of plus-tagged signups printed once per account per hour;
 *  - an ACCOUNT stage move that is neither owner-pinned, nor money starting, nor
 *    an account with money or traffic behind it being closed. `signed-up → active`
 *    is the request counter crossing 1 (the usage row already said it),
 *    `signed-up → lost` is a farm signup that never called being swept, and
 *    anything touching `new` is the orphan-baseline flap, a stage a live account
 *    cannot hold;
 *  - a NON-ACCOUNT move out of `new` that the machine wrote, or that duplicates
 *    the item's own arrival row in this same view.
 *
 * A suspension is never quiet when the account had paid or served traffic. The
 * security page counts standing suspensions, but it cannot date one (the console
 * reports suspended as a bare boolean), so the dated row in this feed is the only
 * place a suspension nobody performed can be noticed. That is not hypothetical:
 * the 2026-08-31 key-containment incident was a suspension without key revocation
 * and it 503'd the whole fleet for 65 minutes.
 *
 * A near miss stays signal. Its own producer (collectors/demand.ts) emits it as
 * "visible, rescuable, but never a board row", deduped once per status id, and
 * this feed is the only surface that names it.
 *
 * A lead-new whose detail is `score 0` (or below) is not signal. Those rows
 * were family-keyword hits with no buyer, and they filled today's feed. The
 * type means a qualified lead entered the pipeline; the ledger still holds the
 * old ones because it is append-only.
 *
 * Nothing else is dropped from the payload. This only sets the flag the view
 * filters on, and the view has a toggle that shows everything except the
 * score-0 arrivals, which activity() strips because they were never leads.
 */
export function eventSignal(e: CrmEvent, ctx?: SignalContext): boolean {
  if (isNoiseLeadArrival(e)) return false;
  if (e.type === 'account-usage') return usageClaimsMoney(e.title) || usageClaimsVolume(e.title);
  if (e.type !== 'stage-change') return true;

  const pinned = e.detail === OWNER_PINNED;
  if (e.itemId?.startsWith('tenant:')) {
    if (pinned) return true;
    const to = stageMovedTo(e.title);
    // Anything LEAVING a stage that had money or traffic behind it is signal,
    // whatever it moves to, EXCEPT into `new`: a live account cannot hold `new`,
    // so that edge is the orphan-baseline flap rather than a downgrade. Today
    // only `lost` is reachable anyway (derivedAccountStage sends a suspended
    // account there, and `paid` never un-sets, so there is no paying -> active),
    // but the catch-all below fails SILENT, and a downgrade that stops being
    // unreachable should arrive as noise rather than as nothing.
    if (to !== 'new' && PAID_OR_TRAFFICKED.has(stageMovedFrom(e.title) ?? '')) return true;
    if (to === 'paying') return true;
    if (to === 'lost') return PAID_OR_TRAFFICKED.has(stageMovedFrom(e.title) ?? '');
    return false;
  }

  if (stageMovedFrom(e.title) === 'new') {
    if (!pinned) return false;
    if (e.itemId && sameDayGroup(e.at, ctx?.arrivals.get(e.itemId))) return false;
    if (stageMovedTo(e.title) === 'contacted' && e.itemId && sameDayGroup(e.at, ctx?.contacted.get(e.itemId))) return false;
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

/** lead-new detail is written `source · score N` by arrivalEvent. */
export function isNoiseLeadArrival(e: CrmEvent): boolean {
  if (e.type !== 'lead-new') return false;
  if (/\bown card\b/i.test(e.detail ?? '')) return false;
  const hit = e.detail?.match(/\bscore (-?\d+)\b/u);
  return hit != null && Number(hit[1]) <= 0;
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
      (item.subtitle ?? '').startsWith('own card') ? 'own card' : null,
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
        // Score-0 noise stays silent. Own-card inbound and owner-touched zeros
        // still announce, matching keepLeadOnBoard.
        if (item.kind === 'lead' && (item.relevance?.score ?? 1) <= 0
          && !(item.subtitle ?? '').startsWith('own card')
          && item.derivedStage !== 'contacted'
          && item.notes.length === 0 && item.contacts.length === 0
          && item.followUpAt == null && item.action == null) {
          state.items[item.id] = next;
          continue;
        }
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
        let anchor = state.usage[item.id];
        if (!anchor) {
          // A first sighting has no window of its own. Falling back to the seed
          // time gave it no coalescing at all, and that is the normal state, not
          // the corner: 511 of the 519 baselined items have never fired a usage
          // event. Open the window here and let the delta ride to the next pass.
          anchor = { at: now, requests: prev.requests ?? 0, spentMicro: prev.spentMicro ?? 0 };
          state.usage[item.id] = anchor;
        }
        const dReq = (item.metrics.requests ?? 0) - anchor.requests;
        const dSpend = (item.metrics.spentMicro ?? 0) - anchor.spentMicro;
        const windowOpen = Date.parse(now) - Date.parse(anchor.at) >= USAGE_COALESCE_MS;
        if (windowOpen && (dReq >= USAGE_MIN_REQUESTS || dSpend > 0)) {
          // `+$0.00` was a lie in two directions at once: it printed for a true
          // zero and for any sub-cent debit, and it read as "money moved" in a
          // feed where money moving is the whole point. A delta under one cent
          // prints requests only.
          //
          // The cent is the print unit, so the report is a WHOLE number of cents
          // and the remainder below one stays owed to the next window. Advancing
          // the anchor to the live counter instead threw the remainder away
          // permanently, and at today's volume that is the normal customer: an
          // account spending $0.009/hour spends ~$78/year with every row hidden.
          const reportedMicro = Math.max(0, Math.floor(dSpend / 10_000) * 10_000);
          const spendClause = reportedMicro > 0 ? ` · +${money(reportedMicro)}` : '';
          emitted.push(this.emit({
            type: 'account-usage',
            itemId: item.id,
            title: `${item.title}: +${dReq} req${spendClause}`,
            detail: `now ${item.metrics.requests} req lifetime · ${money(item.metrics.spentMicro)} spent`,
            url: null,
          }));
          state.usage[item.id] = {
            at: now,
            requests: item.metrics.requests,
            // min() covers a restated book: when lifetime spend goes DOWN the
            // carry is meaningless and the live counter is the honest anchor.
            spentMicro: Math.min(item.metrics.spentMicro, anchor.spentMicro + reportedMicro),
          };
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
    const inWindow = events.filter((e) => Date.parse(e.at) >= cutoff && !isNoiseLeadArrival(e));
    // Duplication is a property of the VIEW, so the context is built over the
    // same window that is served. The day digest counts a subset of it.
    const ctx = signalContext(inWindow);
    const windowed = [...inWindow].reverse().map((e) => ({ ...e, signal: eventSignal(e, ctx) }));
    const today: Partial<Record<CrmEventType, number>> = {};
    const todaySignal: Partial<Record<CrmEventType, number>> = {};
    const day = now.slice(0, 10);
    for (const e of events) {
      if (e.at.slice(0, 10) !== day) continue;
      if (isNoiseLeadArrival(e)) continue;
      today[e.type] = (today[e.type] ?? 0) + 1;
      if (eventSignal(e, ctx)) todaySignal[e.type] = (todaySignal[e.type] ?? 0) + 1;
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
