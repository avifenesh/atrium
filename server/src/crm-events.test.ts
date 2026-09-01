import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crmEvents, eventSignal } from './crm-events.js';
import type { CrmEvent, CrmItem } from '../../shared/types.js';

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

// The signal flag is what "make it quiet" hangs on. It is computed at serve time
// over the raw ledger, so it has to read rows written before it existed the same
// way it reads new ones, and it must never quiet money or a person arriving.

test('a request-only usage delta prints no money clause and is not signal', async () => {
  await withEvents(async (dir) => {
    const past = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(dir, 'crm-events-state.json'), JSON.stringify({
      seededAt: past,
      items: {
        'tenant:t-farm': { kind: 'account', stage: 'signed-up', requests: 0, spentMicro: 0, lastActiveDay: today, quiet: false },
      },
      usage: {},
    }));
    crmEvents._resetForTest(dir);
    await crmEvents.load();

    const fired = await crmEvents.observe([
      account('tenant:t-farm', { requests: 2, spentMicro: 0 }, { stage: 'signed-up', derivedStage: 'signed-up' }),
    ]);
    assert.deepEqual(fired.map((e) => e.type), ['account-usage']);
    assert.equal(fired[0]?.title, 't-tenant:t-farm: +2 req', 'no +$0.00: the print was a zero wearing a money sign');

    const [served] = crmEvents.activity().events;
    assert.equal(served?.signal, false, 'a request counter ticking is not a decision');
  });
});

test('usage with real cents stays signal', () => {
  assert.equal(eventSignal({
    at: '2026-08-31T13:22:16.427Z', type: 'account-usage', itemId: 'tenant:t-real',
    title: 'ofek@nivision.co.il: +28 req · +$0.27', detail: null, url: null,
  }), true);
  assert.equal(eventSignal({
    at: '2026-09-01T10:58:20.655Z', type: 'account-usage', itemId: 'tenant:t-farm',
    title: 'danimsibads+tv217@gmail.com: +1 req · +$0.00', detail: null, url: null,
  }), false, 'the rows already on disk read the same way as the new shape');
});

test('account stage moves are mechanism unless money starts', () => {
  const move = (title: string, itemId = 'tenant:t-1') => eventSignal({
    at: '2026-09-01T10:58:20.654Z', type: 'stage-change', itemId, title, detail: null, url: null,
  });
  assert.equal(move('a@b.com: signed-up → active'), false, 'the request counter crossed 1, the usage row said it');
  assert.equal(move('a@b.com: signed-up → lost'), false, 'the owner suspended it; the security page counts those');
  assert.equal(move('a@b.com: active → new'), false, 'a live account cannot hold new: orphan-baseline flap');
  assert.equal(move('a@b.com: new → active'), false);
  assert.equal(move('a@b.com: active → paying'), true, 'money starting is always news');
  assert.equal(move('acme wants an api: contacted → replied', 'x:2089854486'), true, 'lead moves are hand work');
});

test('near misses leave the motion feed, arrivals and churn never do', () => {
  const row = (type: CrmEvent['type'], title = 'x') =>
    eventSignal({ at: '2026-09-01T00:00:00Z', type, itemId: 'tenant:t-1', title, detail: null, url: null });
  assert.equal(row('near-miss'), false);
  assert.equal(row('account-new', 'signup: a@b.com'), true);
  assert.equal(row('account-quiet', 'gone quiet: a@b.com'), true);
  assert.equal(row('account-resumed', 'back: a@b.com'), true);
  assert.equal(row('lead-new'), true);
  assert.equal(row('direction-new'), true);
  assert.equal(row('contact-logged'), true);
  assert.equal(row('do-launched'), true);
});

test('the today digest is counted twice: every row, and the signal rows only', async () => {
  await withEvents(async () => {
    crmEvents.emit({ type: 'near-miss', itemId: 'x:9', title: 'we spend a lot', detail: null, url: null });
    crmEvents.emit({ type: 'account-new', itemId: 'tenant:t-9', title: 'signup: a@b.com', detail: null, url: null });
    await crmEvents.flush();

    const activity = crmEvents.activity();
    assert.equal(activity.today['near-miss'], 1, 'nothing is deleted from the payload');
    assert.ok(activity.todaySignal, 'the daemon always serves the signal digest');
    assert.equal(activity.todaySignal['near-miss'], undefined, 'but the quiet digest does not advertise it');
    assert.equal(activity.todaySignal['account-new'], 1);
  });
});
