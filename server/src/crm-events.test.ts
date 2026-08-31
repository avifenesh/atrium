import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crmEvents } from './crm-events.js';
import type { CrmItem } from '../../shared/types.js';

// The differ is the CRM's memory of motion. These pin its three contracts:
// a first run seeds silently (no 300-event flood on deploy), a restart does
// not re-announce what was already seen (the baseline file is load-bearing),
// and usage deltas coalesce so a busy customer is one line an hour.

function item(id: string, over: Partial<CrmItem> = {}): CrmItem {
  return {
    id,
    kind: 'lead',
    title: `t-${id}`,
    subtitle: null,
    source: 'hn',
    detail: null,
    url: `https://example.com/${id}`,
    action: null,
    stage: 'new',
    derivedStage: 'new',
    overridden: false,
    followUpAt: null,
    followUpDue: false,
    notes: [],
    contacts: [],
    metrics: null,
    activityAt: '2026-08-30T00:00:00Z',
    relevance: { score: 7, labels: ['company voice'], qualified: true },
    ...over,
  };
}

function account(id: string, metrics: Partial<NonNullable<CrmItem['metrics']>> = {}, over: Partial<CrmItem> = {}): CrmItem {
  return item(id, {
    kind: 'account',
    stage: 'active',
    derivedStage: 'active',
    source: 'console',
    url: null,
    relevance: null,
    metrics: {
      requests: 10,
      spentMicro: 100_000,
      paid: false,
      creditedMicro: null,
      balanceMicro: null,
      enrolled: true,
      suspended: false,
      lastActiveDay: new Date().toISOString().slice(0, 10),
      signupRef: null,
      requestsToday: null,
      debitedTodayMicro: null,
      requestsWindow: null,
      ...metrics,
    },
    ...over,
  });
}

async function withEvents(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-crm-events-'));
  crmEvents._resetForTest(dir);
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('first observe seeds silently; the second reports only what moved', async () => {
  await withEvents(async () => {
    const seeded = await crmEvents.observe([item('s-1'), account('tenant:t-1')]);
    assert.equal(seeded.length, 0, 'seeding must not flood the feed with the whole board');

    const events = await crmEvents.observe([
      item('s-1', { stage: 'contacted' }),           // moved
      account('tenant:t-1'),                          // unchanged
      item('s-2'),                                    // arrived
      account('tenant:t-2', {}, { stage: 'signed-up', derivedStage: 'signed-up' }), // signed up
    ]);
    const types = events.map((e) => e.type).sort();
    assert.deepEqual(types, ['account-new', 'lead-new', 'stage-change']);

    const arrival = events.find((e) => e.type === 'lead-new');
    assert.equal(arrival?.itemId, 's-2');
    assert.match(arrival?.detail ?? '', /score 7 — company voice/);

    const move = events.find((e) => e.type === 'stage-change');
    assert.match(move?.title ?? '', /new → contacted/);
  });
});

test('a restart re-announces nothing: baseline and ledger survive on disk', async () => {
  await withEvents(async (dir) => {
    await crmEvents.observe([item('s-1')]);
    await crmEvents.observe([item('s-1'), item('s-2')]); // s-2 arrives
    assert.equal(crmEvents.activity().events.length, 1);

    // simulate the daemon restarting: fresh module state, same files
    crmEvents._resetForTest(dir);
    await crmEvents.load();
    assert.equal(crmEvents.activity().events.length, 1, 'the ledger reloads');
    const events = await crmEvents.observe([item('s-1'), item('s-2')]);
    assert.equal(events.length, 0, 'nothing moved, so nothing is re-announced');
    assert.equal(crmEvents.seen('lead-new', 's-2'), true);
  });
});

test('quiet and resume transitions fire exactly on the crossing', async () => {
  await withEvents(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const longAgo = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
    await crmEvents.observe([account('tenant:t-q', { lastActiveDay: today })]);

    const wentQuiet = await crmEvents.observe([account('tenant:t-q', { lastActiveDay: longAgo })]);
    assert.deepEqual(wentQuiet.map((e) => e.type), ['account-quiet']);
    assert.match(wentQuiet[0]?.detail ?? '', /9d ago/);

    const stillQuiet = await crmEvents.observe([account('tenant:t-q', { lastActiveDay: longAgo })]);
    assert.equal(stillQuiet.length, 0, 'quiet fires on the crossing, not every poll');

    const back = await crmEvents.observe([account('tenant:t-q', { lastActiveDay: today })]);
    assert.deepEqual(back.map((e) => e.type), ['account-resumed']);
  });
});

test('usage deltas coalesce: within the window nothing prints, past it one summed line', async () => {
  await withEvents(async (dir) => {
    // Craft a baseline whose seed is 2h old, so the first delta's window is open.
    const past = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(dir, 'crm-events-state.json'), JSON.stringify({
      seededAt: past,
      items: {
        'tenant:t-u': { kind: 'account', stage: 'active', requests: 10, spentMicro: 100_000, lastActiveDay: today, quiet: false },
      },
      usage: {},
    }));
    crmEvents._resetForTest(dir);
    await crmEvents.load();

    const first = await crmEvents.observe([account('tenant:t-u', { requests: 24, spentMicro: 400_000 })]);
    assert.deepEqual(first.map((e) => e.type), ['account-usage']);
    assert.match(first[0]?.title ?? '', /\+14 req · \+\$0\.30/);

    // more traffic five minutes later: the window is closed, nothing prints
    const second = await crmEvents.observe([account('tenant:t-u', { requests: 30, spentMicro: 500_000 })]);
    assert.equal(second.length, 0, 'inside the coalesce window the delta waits');
  });
});

test('emit + activity: caps, today digest, and the ledger file shape', async () => {
  await withEvents(async (dir) => {
    crmEvents.emit({ type: 'near-miss', itemId: 'x:1', title: 'we spend a lot', detail: 'scored 4/5', url: 'https://x.com/1' });
    crmEvents.emit({ type: 'do-launched', itemId: 's-1', title: 'do reply', detail: null, url: null });
    await crmEvents.flush();

    const activity = crmEvents.activity();
    assert.equal(activity.events.length, 2);
    assert.equal(activity.events[0]?.type, 'do-launched', 'newest first');
    assert.equal(activity.today['near-miss'], 1);
    assert.equal(activity.today['do-launched'], 1);
    assert.equal(crmEvents.seen('near-miss', 'x:1'), true);
    assert.equal(crmEvents.seen('near-miss', 'x:2'), false);

    const raw = await readFile(join(dir, 'crm-events.jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2, 'one JSONL line per event');
  });
});
