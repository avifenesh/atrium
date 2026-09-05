import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crmEvents } from './crm-events.js';
import {
  checkoutFlags,
  errorFlags,
  errorsToCrmEvents,
  ingestJourney,
  ingestServingErrors,
  journeyToCrmEvent,
  loadCursor,
} from './crm-journey.js';
import type { JourneyEvent } from './core/tiyuvta.js';

// The two feeds that put the customer path and the customers' errors on the account.
// Contracts pinned here:
//   - a failed checkout is two different rows: closed before paying vs card declined
//   - the owner's own accounts and the plumbing the differ already announces are dropped
//   - the journey cursor survives restarts and a page boundary files nothing twice
//   - error rows coalesce per (tenant, model, status, code) and are never refiled
//   - lost checkouts and error clusters raise id-stable warn flags, and only while recent

const T0 = Date.UTC(2026, 8, 5, 12, 0, 0);
const ev = (over: Partial<JourneyEvent>): JourneyEvent => ({
  at: T0, type: 'signup', tenantId: 'ten_a', email: 'a@example.com', internal: false, detail: {}, ...over,
});

test('journeyToCrmEvent: closed vs declined, plumbing dropped, owner accounts dropped', () => {
  const closed = journeyToCrmEvent(ev({ type: 'purchase-failed', detail: { usd: 5, reason: 'canceled', txn: 'txn_1' } }));
  assert.equal(closed?.type, 'checkout-closed');
  assert.match(closed!.title, /checkout closed before paying: a@example.com · \$5\.00/);
  const declined = journeyToCrmEvent(ev({ type: 'purchase-failed', detail: { usd: 1000, reason: 'payment_failed', txn: 'txn_2' } }));
  assert.equal(declined?.type, 'checkout-declined');
  assert.match(declined!.title, /card declined: a@example.com · \$1000\.00/);
  assert.equal(journeyToCrmEvent(ev({ type: 'purchase-completed', detail: { usd: 10, pack: 'usd10' } }))?.type, 'purchase-completed');
  assert.equal(journeyToCrmEvent(ev({ type: 'checkout-opened', detail: { usd: 5 } }))?.type, 'checkout-opened');
  assert.equal(journeyToCrmEvent(ev({ type: 'signup', detail: { ref: 'hn-launch', click: 'gclid' } }))?.detail, 'via hn-launch · ad click (gclid)');
  assert.equal(journeyToCrmEvent(ev({ type: 'signup', detail: {} })), null, 'a plain signup is the differ\'s account-new');
  assert.equal(journeyToCrmEvent(ev({ type: 'enrolled' })), null);
  assert.equal(journeyToCrmEvent(ev({ type: 'credit-applied', detail: { provider: 'paddle', usd: 10 } })), null, 'paddle credit duplicates the purchase row');
  assert.equal(journeyToCrmEvent(ev({ type: 'credit-applied', detail: { provider: 'owner_grant', usd: 5 } }))?.title, 'owner grant: a@example.com · $5.00');
  assert.equal(journeyToCrmEvent(ev({ type: 'mail-sent', detail: { kind: 'notice', campaign: 'notice:x' } }))?.title, 'notice mail: a@example.com');
  assert.equal(journeyToCrmEvent(ev({ type: 'key-minted', internal: true })), null, 'the owner\'s own accounts are not pipeline');
  for (const row of [closed, declined]) assert.equal(row?.itemId, 'tenant:ten_a');
});

test('ingestJourney: backfills from zero, pages on truncation, refiles nothing after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-crm-journey-'));
  crmEvents._resetForTest(dir);
  const cursorFile = join(dir, 'crm-journey-cursor.json');
  const all: JourneyEvent[] = [
    ev({ at: T0, type: 'signup', detail: { ref: 'x' } }),
    ev({ at: T0 + 1, type: 'key-minted', detail: { prefix: 'mk' } }),
    ev({ at: T0 + 1, type: 'first-call' }),
    ev({ at: T0 + 2, type: 'checkout-opened', detail: { usd: 5 } }),
    ev({ at: T0 + 3, type: 'purchase-failed', detail: { usd: 5, reason: 'canceled' } }),
  ];
  const calls: Array<[number, number, number]> = [];
  const reader = async (since: number, until: number, limit: number) => {
    calls.push([since, until, limit]);
    const inWindow = all.filter((e) => e.at >= since && e.at < until);
    return { events: inWindow.slice(0, limit), truncated: inWindow.length > limit };
  };
  const first = await ingestJourney({ reader, cursorFile, now: T0 + 10, pageLimit: 2 });
  assert.equal(first.emitted, 5, 'every row is filed, across pages');
  assert.equal(first.cursor, T0 + 3);
  assert.ok(calls.length >= 2, 'paged');
  const cursor = await loadCursor(cursorFile);
  assert.equal(cursor.since, T0 + 3);
  assert.deepEqual(cursor.seen, ['purchase-failed|ten_a|' + (T0 + 3)]);

  // restart: same reader, nothing new -> nothing refiled, cursor unchanged
  const again = await ingestJourney({ reader, cursorFile, now: T0 + 10, pageLimit: 2 });
  assert.equal(again.emitted, 0);
  // a new row at the SAME millisecond as the cursor is still filed (the key is new)
  all.push(ev({ at: T0 + 3, type: 'mail-sent', detail: { kind: 'welcome' } }));
  const third = await ingestJourney({ reader, cursorFile, now: T0 + 10, pageLimit: 2 });
  assert.equal(third.emitted, 1);
  const ledger = (await readFile(join(dir, 'crm-events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(ledger.length, 6);
  assert.ok(ledger.every((line) => JSON.parse(line).itemId === 'tenant:ten_a'));
  await rm(dir, { recursive: true, force: true });
});

test('errorsToCrmEvents: coalesces per tenant/model/status/code and skips seen rows', () => {
  const boxes = {
    box13: { customer_errors_1h: [
      { t: T0 + 1, tenant: 'ten_a', model: 'qwen/qwen3.8-27b', status: 499, code: 'client_disconnected_or_handler_dropped', prompt: 132363 },
      { t: T0 + 2, tenant: 'ten_a', model: 'qwen/qwen3.8-27b', status: 499, code: 'client_disconnected_or_handler_dropped', prompt: 38843 },
      { t: T0 + 3, tenant: 'ten_b', model: 'qwen/qwen3.8-27b', status: 408, code: 'deadline_exceeded', prompt: 100 },
      { t: T0 + 4, tenant: 'watchdog-box13', model: 'qwen/qwen3.8-27b', status: 408, code: 'deadline_exceeded', prompt: 13 },
    ] },
    _meta: undefined,
  };
  const emailOf = (t: string) => (t === 'ten_a' ? 'a@example.com' : null);
  const seen = new Set<string>();
  const { events, keys } = errorsToCrmEvents(boxes, emailOf, seen);
  assert.equal(keys.length, 3, 'the watchdog row is not a customer row');
  assert.equal(events.length, 2);
  const a = events.find((e) => e.itemId === 'tenant:ten_a')!;
  assert.equal(a.type, 'request-error');
  assert.equal(a.title, 'error: a@example.com · 2x 499 client_disconnected_or_handler_dropped on qwen3.8-27b');
  assert.match(a.detail!, /prompts 39k-132k tokens · box13/);
  const b = events.find((e) => e.itemId === 'tenant:ten_b')!;
  assert.equal(b.title, 'error: ten_b · 1x 408 deadline_exceeded on qwen3.8-27b', 'an unknown tenant keeps its id');
  // the same rows again: all seen, nothing filed
  for (const k of keys) seen.add(k);
  assert.deepEqual(errorsToCrmEvents(boxes, emailOf, seen).events, []);
});

test('ingestServingErrors: reads state.json, files once, persists the seen keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-crm-errors-'));
  crmEvents._resetForTest(dir);
  const cursorFile = join(dir, 'crm-journey-cursor.json');
  const statePath = join(dir, 'state.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(statePath, JSON.stringify({
    _meta: { ts: 'x' },
    box13: { health_code: '200', customer_errors_1h: [{ t: T0 + 1, tenant: 'ten_a', model: 'm', status: 499, code: 'client_disconnected_or_handler_dropped' }] },
    glm53tx: { health_code: '200' },
  }));
  const first = await ingestServingErrors(() => 'a@example.com', { statePath, cursorFile });
  assert.equal(first.emitted, 1);
  const second = await ingestServingErrors(() => 'a@example.com', { statePath, cursorFile });
  assert.equal(second.emitted, 0, 'the same export a minute later files nothing');
  const cursor = await loadCursor(cursorFile);
  assert.equal(cursor.errorsSeen.length, 1);
  assert.equal(cursor.since, 0, 'the journey cursor is untouched by the error feed');
  const missing = await ingestServingErrors(() => null, { statePath: join(dir, 'nope.json'), cursorFile });
  assert.equal(missing.emitted, 0, 'no sentinel state is not an error');
  await rm(dir, { recursive: true, force: true });
});

test('flags: lost checkouts and error clusters, recent only, id-stable', () => {
  const now = '2026-09-05T12:00:00.000Z';
  const events = [
    { at: '2026-09-05T11:00:00.000Z', type: 'checkout-closed' as const, itemId: 'tenant:ten_a', title: 'checkout closed before paying: a@example.com · $5.00', detail: 'paddle: canceled', url: null },
    { at: '2026-09-01T11:00:00.000Z', type: 'checkout-declined' as const, itemId: 'tenant:ten_b', title: 'card declined: b · $1000.00', detail: null, url: null },
    { at: '2026-09-05T09:00:00.000Z', type: 'request-error' as const, itemId: 'tenant:ten_a', title: 'error: a · 2x 499 on qwen', detail: 'box13', url: null },
    { at: '2026-09-05T11:30:00.000Z', type: 'request-error' as const, itemId: 'tenant:ten_a', title: 'error: a · 1x 499 on qwen', detail: 'box13', url: null },
    { at: '2026-09-04T11:30:00.000Z', type: 'request-error' as const, itemId: 'tenant:ten_c', title: 'old', detail: null, url: null },
  ];
  const c = checkoutFlags(events, now);
  assert.equal(c.length, 1, 'the four-day-old decline is not a flag any more');
  assert.equal(c[0]!.id, 'crm:checkout:tenant:ten_a:2026-09-05T11:00:00.000Z');
  assert.equal(c[0]!.severity, 'warn');
  const e = errorFlags(events, now);
  assert.equal(e.length, 1, 'one flag per account, newest cluster, six-hour window');
  assert.equal(e[0]!.id, 'crm:errors:tenant:ten_a');
  assert.match(e[0]!.title, /1x 499/);
});
