// The customer path and the customers' errors, filed on the account.
//
// Owner, 2026-09-05: "I want it in the CRM, I need to know about it, and I need it to track
// the whole path before and after. Why we don't track this." The honest answer: the console
// recorded every step (signup with its ref and ad click id, enrolment, key mint, first call,
// every checkout opened, every failed checkout with its reason, every purchase, grant and
// mail, suspension) and exported only aggregates; this CRM diffs those aggregates, so an
// attempt that moved no number, a checkout opened and closed, could not exist here. Seven
// abandoned or declined checkouts since 08-25 reached nobody. Errors were the same shape one
// layer down: only the box ledgers record a failed request, and nothing off the box read them.
//
// Two feeds now, both idempotent across restarts:
//
//   console /admin/journey  ->  ingestJourney()        cursor on `at` in crm-journey-cursor.json
//   sentinel state.json     ->  ingestServingErrors()  per-row keys in the same cursor file
//
// Each event lands in the crm-events ledger under the account's item id (`tenant:<id>`), so
// the account's timeline shows the path and the feed shows the motion. Money and errors are
// signal (they reach the digest and the phone); the plumbing rows (key minted, first call,
// mails) are kept quiet by crm-events' QUIET_JOURNEY set.
//
// Flags: a lost checkout or a customer's error cluster in the last two days is a warn on
// the strip, id-stable so a mute sticks. They are recomputed from the ledger every poll,
// never stored, so nothing can go stale on its own.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { config } from './config.js';
import { crmEvents } from './crm-events.js';
import { readJourney, type JourneyEvent } from './core/tiyuvta.js';
import { iso, readJson } from './util.js';
import type { CrmEvent, CrmEventType, Flag } from '../../shared/types.js';

export interface JourneyCursor {
  /** Every journey event with `at` < since has been filed. */
  since: number;
  /** Keys (type|tenant|at) already filed AT `since`, so a page boundary re-serves nothing twice. */
  seen: string[];
  /** Serving error rows already filed (box|t|tenant|status|code), newest last, capped. */
  errorsSeen: string[];
}

const ERRORS_SEEN_CAP = 4000;
const LOST_CHECKOUT_FLAG_HOURS = 48;
const ERROR_FLAG_HOURS = 6;

export function cursorPath(): string {
  return join(config.configDir, 'crm-journey-cursor.json');
}

function servingStatePath(): string {
  const dir = (config as unknown as { serving?: { stateDir?: string } }).serving?.stateDir
    || join(homedir(), '.local', 'state', 'tiyuvta-serving');
  return join(dir, 'state.json');
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

export async function loadCursor(path = cursorPath()): Promise<JourneyCursor> {
  const raw = await readJson<Partial<JourneyCursor>>(path);
  return {
    since: typeof raw?.since === 'number' && raw.since >= 0 ? raw.since : 0,
    seen: Array.isArray(raw?.seen) ? raw.seen.filter((k): k is string => typeof k === 'string') : [],
    errorsSeen: Array.isArray(raw?.errorsSeen) ? raw.errorsSeen.filter((k): k is string => typeof k === 'string') : [],
  };
}

const usd = (v: unknown): string | null => (typeof v === 'number' ? `$${v.toFixed(2)}` : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** One console journey event as a CRM event, or null when the row is nobody's business here
 *  (the owner's own accounts, and plumbing the differ already announces). */
export function journeyToCrmEvent(e: JourneyEvent): (Omit<CrmEvent, 'at'> & { at: string }) | null {
  if (e.internal) return null;
  const itemId = `tenant:${e.tenantId}`;
  const at = iso(e.at);
  const who = e.email;
  const d = e.detail ?? {};
  const row = (type: CrmEventType, title: string, detail: string | null): Omit<CrmEvent, 'at'> & { at: string } =>
    ({ at, type, itemId, title, detail, url: null });
  switch (e.type) {
    case 'signup': {
      // account-new comes from the differ; only the BEFORE path is news here.
      const ref = str(d.ref);
      const click = str(d.click);
      if (!ref && !click) return null;
      return row('account-source', `source: ${who}`, [ref ? `via ${ref}` : null, click ? `ad click (${click})` : null].filter(Boolean).join(' · '));
    }
    case 'enrolled':
      return null; // automatic, seconds after signup: timeline noise
    case 'suspended':
      return row('account-suspended', `suspended: ${who}`, str(d.reason));
    case 'key-minted':
      return row('key-minted', `key minted: ${who}`, str(d.prefix));
    case 'key-revoked':
      return null; // revocation follows suspension or the owner's own action; not motion
    case 'first-call':
      return row('first-call', `first call: ${who}`, null);
    case 'day2-claimed':
      return row('offer-claimed', `day-2 offer claimed: ${who}`, null);
    case 'checkout-opened':
      return row('checkout-opened', `checkout opened: ${who} · ${usd(d.usd) ?? '?'}`, [str(d.pack), str(d.kind), str(d.txn)].filter(Boolean).join(' · ') || null);
    case 'purchase-completed':
      return row('purchase-completed', `paid: ${who} · ${usd(d.usd) ?? '?'}`, [str(d.pack), typeof d.discount_usd === 'number' && d.discount_usd > 0 ? `discount ${usd(d.discount_usd)}` : null, str(d.txn)].filter(Boolean).join(' · ') || null);
    case 'purchase-failed': {
      const reason = str(d.reason);
      const declined = reason === 'payment_failed';
      return row(
        declined ? 'checkout-declined' : 'checkout-closed',
        `${declined ? 'card declined' : 'checkout closed before paying'}: ${who} · ${usd(d.usd) ?? '?'}`,
        [reason ? `paddle: ${reason}` : null, str(d.txn)].filter(Boolean).join(' · ') || null,
      );
    }
    case 'credit-applied': {
      const provider = str(d.provider);
      if (provider === 'paddle') return null; // the purchase-completed row already says it
      const label = provider === 'owner_grant' ? 'owner grant' : provider === 'promo' ? 'signup promo' : provider === 'enrollment' ? 'enrolment credit' : provider === 'training_consent' ? 'training-consent credit' : provider ?? 'credit';
      return row('credit-granted', `${label}: ${who} · ${usd(d.usd) ?? '?'}`, str(d.ref));
    }
    case 'reversal':
      return row('purchase-reversed', `reversal: ${who} · ${usd(d.usd) ?? '?'}`, str(d.ref));
    case 'mail-sent': {
      const kind = str(d.kind) ?? 'mail';
      const campaign = str(d.campaign);
      return row('mail-sent', `${kind} mail: ${who}`, campaign);
    }
    case 'gads-conversion':
      return null; // purchase-completed carries the money; the Ads upload is bookkeeping
    default:
      return null;
  }
}

export const journeyKey = (e: JourneyEvent): string => `${e.type}|${e.tenantId}|${e.at}`;

export type JourneyReader = (since: number, until: number, limit: number) => Promise<{ events: JourneyEvent[]; truncated: boolean }>;

/**
 * Pull everything since the cursor from the console and file it. First run backfills from
 * the beginning of the account book: rows keep their real `at`, so the timeline reads true
 * and the day digests file under the days they happened, not today.
 */
export async function ingestJourney(
  options: { reader?: JourneyReader; cursorFile?: string; now?: number; pageLimit?: number } = {},
): Promise<{ emitted: number; cursor: number }> {
  const reader = options.reader ?? ((since, until, limit) => readJourney(since, until, limit));
  const file = options.cursorFile ?? cursorPath();
  const now = options.now ?? Date.now();
  const limit = options.pageLimit ?? 2000;
  const cursor = await loadCursor(file);
  let since = cursor.since;
  let seen = new Set(cursor.seen);
  let emitted = 0;
  for (let page = 0; page < 50; page += 1) {
    const { events, truncated } = await reader(since, now + 60_000, limit);
    if (events.length === 0) break;
    let progressed = false;
    for (const e of events) {
      const key = journeyKey(e);
      if (e.at === since && seen.has(key)) continue;
      progressed = true;
      const mapped = journeyToCrmEvent(e);
      if (mapped) {
        crmEvents.emit(mapped);
        emitted += 1;
      }
      if (e.at !== since) {
        since = e.at;
        seen = new Set();
      }
      seen.add(key);
    }
    if (!truncated) break;
    if (!progressed) {
      // A whole page of rows at the cursor millisecond, every one already filed: the
      // window [since, until) cannot move by re-reading it. Everything AT `since` is done
      // (the page is served oldest-first and was fully seen), so step past it.
      since += 1;
      seen = new Set();
    }
  }
  await atomicWrite(file, JSON.stringify({ since, seen: [...seen], errorsSeen: cursor.errorsSeen }, null, 1));
  await crmEvents.flush();
  return { emitted, cursor: since };
}

// --- serving errors -------------------------------------------------------------------

export interface ServingError {
  t: number | null;
  tenant: string;
  model: string | null;
  status: number | null;
  code: string | null;
  route?: string | null;
  prompt?: number | null;
  elapsed_s?: number | null;
}

export const errorKey = (box: string, r: ServingError): string => `${box}|${r.t ?? 0}|${r.tenant}|${r.status ?? ''}|${r.code ?? ''}`;

/** Coalesce a batch of unseen error rows into one CRM event per (tenant, model, status,
 *  code): "3x 499 client_disconnected on qwen3.8, prompts 38k-134k, box13". */
export function errorsToCrmEvents(
  boxes: Record<string, { customer_errors_1h?: ServingError[] } | undefined>,
  emailOf: (tenantId: string) => string | null,
  seen: Set<string>,
): { events: Array<Omit<CrmEvent, 'at'> & { at: string }>; keys: string[] } {
  const groups = new Map<string, { tenant: string; model: string; status: string; code: string; rows: ServingError[]; boxes: Set<string> }>();
  const keys: string[] = [];
  for (const [box, state] of Object.entries(boxes)) {
    for (const r of state?.customer_errors_1h ?? []) {
      if (!r || typeof r.tenant !== 'string' || !r.tenant.startsWith('ten_')) continue;
      const key = errorKey(box, r);
      if (seen.has(key)) continue;
      keys.push(key);
      const gk = `${r.tenant}|${r.model ?? '?'}|${r.status ?? '?'}|${r.code ?? ''}`;
      const g = groups.get(gk) ?? { tenant: r.tenant, model: r.model ?? '?', status: String(r.status ?? '?'), code: r.code ?? '', rows: [], boxes: new Set<string>() };
      g.rows.push(r);
      g.boxes.add(box);
      groups.set(gk, g);
    }
  }
  const events: Array<Omit<CrmEvent, 'at'> & { at: string }> = [];
  for (const g of groups.values()) {
    const latest = Math.max(...g.rows.map((r) => r.t ?? 0));
    const prompts = g.rows.map((r) => r.prompt).filter((p): p is number => typeof p === 'number');
    const span = prompts.length
      ? `prompts ${Math.round(Math.min(...prompts) / 1000)}k-${Math.round(Math.max(...prompts) / 1000)}k tokens`
      : null;
    const who = emailOf(g.tenant) ?? g.tenant;
    const model = g.model.replace(/^[^/]+\//, '');
    events.push({
      at: iso(latest || Date.now()),
      type: 'request-error',
      itemId: `tenant:${g.tenant}`,
      title: `error: ${who} · ${g.rows.length}x ${g.status}${g.code ? ` ${g.code}` : ''} on ${model}`,
      detail: [span, [...g.boxes].join(', '), g.rows[0]?.route ?? null].filter(Boolean).join(' · ') || null,
      url: null,
    });
  }
  return { events, keys };
}

/** Read the sentinel's state.json and file every error row not filed before. */
export async function ingestServingErrors(
  emailOf: (tenantId: string) => string | null,
  options: { statePath?: string; cursorFile?: string } = {},
): Promise<{ emitted: number }> {
  const statePath = options.statePath ?? servingStatePath();
  const file = options.cursorFile ?? cursorPath();
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch {
    return { emitted: 0 }; // no sentinel here: nothing to file, not an error
  }
  const state = JSON.parse(raw) as Record<string, unknown>;
  const boxes: Record<string, { customer_errors_1h?: ServingError[] }> = {};
  for (const [name, value] of Object.entries(state)) {
    if (name.startsWith('_') || !value || typeof value !== 'object') continue;
    const errs = (value as { customer_errors_1h?: unknown }).customer_errors_1h;
    if (Array.isArray(errs)) boxes[name] = { customer_errors_1h: errs as ServingError[] };
  }
  const cursor = await loadCursor(file);
  const seen = new Set(cursor.errorsSeen);
  const { events, keys } = errorsToCrmEvents(boxes, emailOf, seen);
  for (const e of events) crmEvents.emit(e);
  if (keys.length > 0) {
    const errorsSeen = [...cursor.errorsSeen, ...keys].slice(-ERRORS_SEEN_CAP);
    await atomicWrite(file, JSON.stringify({ since: cursor.since, seen: cursor.seen, errorsSeen }, null, 1));
    await crmEvents.flush();
  }
  return { emitted: events.length };
}

// --- flags ----------------------------------------------------------------------------

function withinHours(at: string, now: string, hours: number): boolean {
  return Date.parse(now) - Date.parse(at) <= hours * 3_600_000;
}

/** A lost checkout in the last two days is a person who wanted to pay: warn, per checkout. */
export function checkoutFlags(events: CrmEvent[], now: string): Flag[] {
  const flags: Flag[] = [];
  for (const e of events) {
    if ((e.type !== 'checkout-closed' && e.type !== 'checkout-declined') || !e.itemId) continue;
    if (!withinHours(e.at, now, LOST_CHECKOUT_FLAG_HOURS)) continue;
    flags.push({
      id: `crm:checkout:${e.itemId}:${e.at}`,
      severity: 'warn',
      title: e.title,
      detail: `${e.detail ?? 'no paddle detail'} · ${e.at.slice(0, 16).replace('T', ' ')}Z`,
      source: 'crm',
      raisedAt: now,
    });
  }
  return flags;
}

/** A customer's error cluster in the last six hours: one warn per account, newest cluster. */
export function errorFlags(events: CrmEvent[], now: string): Flag[] {
  const newest = new Map<string, CrmEvent>();
  for (const e of events) {
    if (e.type !== 'request-error' || !e.itemId || !withinHours(e.at, now, ERROR_FLAG_HOURS)) continue;
    const prev = newest.get(e.itemId);
    if (!prev || Date.parse(e.at) > Date.parse(prev.at)) newest.set(e.itemId, e);
  }
  return [...newest.values()].map((e) => ({
    id: `crm:errors:${e.itemId}`,
    severity: 'warn' as const,
    title: e.title,
    detail: `${e.detail ?? ''} · ${e.at.slice(0, 16).replace('T', ' ')}Z`,
    source: 'crm',
    raisedAt: now,
  }));
}
