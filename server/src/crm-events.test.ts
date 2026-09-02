import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crmEvents, eventSignal, isNoiseLeadArrival, signalContext } from './crm-events.js';
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

/** A state file with the usage window already open for one account, which is what
 *  every account looks like after its first hour of being watched. */
async function seedUsage(
  dir: string,
  id: string,
  over: { stage?: string; requests?: number; spentMicro?: number } = {},
): Promise<void> {
  const past = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const baseline = {
    kind: 'account',
    stage: 'active',
    requests: 10,
    spentMicro: 100_000,
    lastActiveDay: new Date().toISOString().slice(0, 10),
    quiet: false,
    ...over,
  };
  await writeFile(join(dir, 'crm-events-state.json'), JSON.stringify({
    seededAt: past,
    items: { [id]: baseline },
    usage: { [id]: { at: past, requests: baseline.requests, spentMicro: baseline.spentMicro } },
  }));
  crmEvents._resetForTest(dir);
  await crmEvents.load();
}

test('usage deltas coalesce: within the window nothing prints, past it one summed line', async () => {
  await withEvents(async (dir) => {
    await seedUsage(dir, 'tenant:t-u');

    const first = await crmEvents.observe([account('tenant:t-u', { requests: 24, spentMicro: 400_000 })]);
    assert.deepEqual(first.map((e) => e.type), ['account-usage']);
    assert.match(first[0]?.title ?? '', /\+14 req · \+\$0\.30/);

    // more traffic five minutes later: the window is closed, nothing prints
    const second = await crmEvents.observe([account('tenant:t-u', { requests: 30, spentMicro: 500_000 })]);
    assert.equal(second.length, 0, 'inside the coalesce window the delta waits');
  });
});

test('a first sighting gets its own window, so its first row coalesces too', async () => {
  await withEvents(async (dir) => {
    // A baselined account with no usage anchor: 511 of the 519 items on disk. The
    // fallback anchored the window on the SEED time, which is hours or days old,
    // so the very first delta printed instantly and a new account's burst of
    // signup traffic arrived as one row per poll.
    const past = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(dir, 'crm-events-state.json'), JSON.stringify({
      seededAt: past,
      items: {
        'tenant:t-first': { kind: 'account', stage: 'active', requests: 0, spentMicro: 0, lastActiveDay: today, quiet: false },
      },
      usage: {},
    }));
    crmEvents._resetForTest(dir);
    await crmEvents.load();

    const first = await crmEvents.observe([account('tenant:t-first', { requests: 6, spentMicro: 40_000 })]);
    assert.deepEqual(first.map((e) => e.type), [], 'the first sighting opens the window instead of printing');

    const second = await crmEvents.observe([account('tenant:t-first', { requests: 9, spentMicro: 90_000 })]);
    assert.equal(second.length, 0, 'and it holds like every other window');
  });
});

test('a sub-cent delta carries: the remainder is owed to the next window, not dropped', async () => {
  await withEvents(async (dir) => {
    // $0.009 an hour is the normal customer at this volume, not a corner: 23 of
    // the 34 external accounts with any spend are under a cent lifetime. The
    // anchor used to jump to the live counter whether or not the money printed,
    // so those cents could never accumulate past the floor and print.
    await seedUsage(dir, 'tenant:t-cents');

    const firstWindow = await crmEvents.observe([account('tenant:t-cents', { requests: 12, spentMicro: 109_000 })]);
    assert.equal(firstWindow.length, 1);
    assert.equal(firstWindow[0]?.title, 't-tenant:t-cents: +2 req', 'nine tenths of a cent prints no money clause');

    // reopen the window: the same trickle again, and the two halves clear a cent
    const state = JSON.parse(await readFile(join(dir, 'crm-events-state.json'), 'utf8'));
    assert.equal(state.usage['tenant:t-cents'].spentMicro, 100_000, 'the anchor moved only to what printed');
    state.usage['tenant:t-cents'].at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await writeFile(join(dir, 'crm-events-state.json'), JSON.stringify(state));
    crmEvents._resetForTest(dir);
    await crmEvents.load();

    const secondWindow = await crmEvents.observe([account('tenant:t-cents', { requests: 14, spentMicro: 118_000 })]);
    assert.equal(secondWindow.length, 1);
    assert.equal(
      secondWindow[0]?.title,
      't-tenant:t-cents: +2 req · +$0.01',
      'the carried remainder cleared the floor and printed',
    );
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
    await seedUsage(dir, 'tenant:t-farm', { stage: 'signed-up', requests: 0, spentMicro: 0 });

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

test('account stage moves are mechanism unless money, traffic or the owner is behind them', () => {
  const move = (title: string, detail: string | null = 'account · derived from sources', itemId = 'tenant:t-1') =>
    eventSignal({ at: '2026-09-01T10:58:20.654Z', type: 'stage-change', itemId, title, detail, url: null });
  assert.equal(move('a@b.com: signed-up → active'), false, 'the request counter crossed 1, the usage row said it');
  assert.equal(move('a@b.com: signed-up → lost'), false, 'a signup that never called being swept');
  assert.equal(move('a@b.com: active → new'), false, 'a live account cannot hold new: orphan-baseline flap');
  assert.equal(move('a@b.com: new → active'), false);
  assert.equal(move('a@b.com: active → paying'), true, 'money starting is always news');
  assert.equal(move('acme wants an api: contacted → replied', 'lead · derived from sources', 'x:2089854486'), true, 'lead moves are hand work');
});

test('a suspended paying customer is never quiet', () => {
  // derivedAccountStage puts suspended ahead of paid, so a paying account being
  // suspended emits exactly `paying → lost` and nothing else. Quieting that made
  // a suspension nobody performed silent on both surfaces, and a suspension
  // without key revocation is what 503'd the whole fleet for 65 minutes on 08-31.
  const move = (title: string) => eventSignal({
    at: '2026-09-01T10:58:20.654Z', type: 'stage-change', itemId: 'tenant:t-1',
    title, detail: 'account · derived from sources', url: null,
  });
  assert.equal(move('ofek@nivision.co.il: paying → lost'), true, 'a paying customer went dark');
  assert.equal(move('ofek@nivision.co.il: active → lost'), true, 'it had served traffic');
  assert.equal(move('f1@asashi.my.id: signed-up → lost'), false, 'the farm sweep stays mechanism');
});

test('an owner-pinned account move is signal, the same as an owner-pinned lead move', () => {
  // The stamp observe() writes is the only record that a move was a decision, and
  // the classifier read the stage names but never the stamp, so hand work on an
  // account vanished while identical hand work on a lead survived.
  assert.equal(eventSignal({
    at: '2026-09-01T10:58:20.654Z', type: 'stage-change', itemId: 'tenant:t-1',
    title: 'a@b.com: active → skipped', detail: 'pinned by owner', url: null,
  }), true);
});

test('a lead move out of new is quiet when it duplicates the arrival row in view', () => {
  const arrival: CrmEvent = {
    at: '2026-09-01T01:18:20.086Z', type: 'lead-new', itemId: 'gh-issue:jundot/omlx/issues/3345',
    title: 'engine loop dies after a long MTP generate', detail: 'github', url: null,
  };
  const skipped: CrmEvent = {
    at: '2026-09-01T01:38:20.108Z', type: 'stage-change', itemId: 'gh-issue:jundot/omlx/issues/3345',
    title: 'engine loop dies after a long MTP generate: new → skipped', detail: 'pinned by owner', url: null,
  };
  assert.equal(
    eventSignal(skipped, signalContext([arrival, skipped])),
    false,
    '"it arrived" and "you already closed it" is one fact, not two rows',
  );
  assert.equal(
    eventSignal(skipped, signalContext([skipped])),
    true,
    'closing something that arrived before this window is the owner telling us something',
  );
  const machine: CrmEvent = { ...skipped, detail: 'lead · derived from sources' };
  assert.equal(eventSignal(machine, signalContext([machine])), false, 'nobody pinned it, so arithmetic moved it');
  const touched: CrmEvent = { ...skipped, title: 'x: new → contacted' };
  const touch: CrmEvent = { ...arrival, type: 'contact-logged', at: '2026-09-01T01:37:00Z' };
  assert.equal(
    eventSignal(touched, signalContext([touch, touched])),
    false,
    'crm.ts advances the stage when a contact is logged, and contact-logged already said so',
  );
});

test('score-0 lead arrivals are not signal and stay off the feed', async () => {
  const noise: CrmEvent = {
    at: '2026-09-02T11:34:49.180Z', type: 'lead-new', itemId: 'hn:49534684',
    title: 'Agentic SQL for Free with Qwen3.8 27B', detail: 'hn · score 0',
    url: 'https://news.ycombinator.com/item?id=49534684',
  };
  const real: CrmEvent = {
    at: '2026-09-02T11:34:49.180Z', type: 'lead-new', itemId: 'x:1',
    title: 'we spend five figures a month on OpenRouter',
    detail: 'x · score 6 — company voice', url: null,
  };
  const ownCard: CrmEvent = {
    ...noise, itemId: 'hf-hub:thread:own#1', detail: 'hf-hub · score 0 · own card',
  };
  assert.equal(isNoiseLeadArrival(noise), true);
  assert.equal(isNoiseLeadArrival(ownCard), false, 'own-card inbound is kept on the board and in the feed');
  assert.equal(isNoiseLeadArrival(real), false);
  assert.equal(eventSignal(noise), false);
  assert.equal(eventSignal(real), true);

  await withEvents(async () => {
    await crmEvents.observe([item('seed')]);
    const moved = await crmEvents.observe([
      item('seed'),
      item('zero', { relevance: { score: 0, labels: [], qualified: false } }),
      item('own', { relevance: { score: 0, labels: [], qualified: false }, subtitle: 'own card · qwen3-8b' }),
      item('real'),
    ]);
    assert.deepEqual(moved.map((e) => e.itemId), ['own', 'real']);
    crmEvents.emit({
      type: 'lead-new', itemId: noise.itemId, title: noise.title, detail: noise.detail, url: noise.url,
    });
    crmEvents.emit({
      type: 'lead-new', itemId: real.itemId, title: real.title, detail: real.detail, url: real.url,
    });
    const activity = crmEvents.activity();
    assert.equal(activity.events.some((e) => e.itemId === 'hn:49534684'), false);
    assert.equal(activity.events.some((e) => e.itemId === 'x:1'), true);
    await crmEvents.flush();
  });
});

test('a near miss is signal: its own producer says visible and rescuable', () => {
  const row = (type: CrmEvent['type'], title = 'x') =>
    eventSignal({ at: '2026-09-01T00:00:00Z', type, itemId: 'tenant:t-1', title, detail: null, url: null });
  assert.equal(row('near-miss', 'we spend a lot on inference'), true, 'the feed is the only surface that names it');
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
    crmEvents.emit({
      type: 'stage-change', itemId: 'tenant:t-9', title: 'a@b.com: signed-up → active',
      detail: 'account · derived from sources', url: null,
    });
    await crmEvents.flush();

    const activity = crmEvents.activity();
    assert.equal(activity.today['stage-change'], 1, 'nothing is deleted from the payload');
    assert.ok(activity.todaySignal, 'the daemon always serves the signal digest');
    assert.equal(activity.todaySignal['stage-change'], undefined, 'but the quiet digest does not advertise it');
    assert.equal(activity.todaySignal['near-miss'], 1);
    assert.equal(activity.todaySignal['account-new'], 1);
  });
});

test('an owner decision in a later day group is never suppressed by yesterday arrival', () => {
  // The dedup exists so "it arrived" and "you already closed it" are not two
  // rows side by side. The feed groups by UTC day, so an arrival in yesterday's
  // group is not next to anything: suppressing there loses the only row today
  // holds about that item.
  const arrival: CrmEvent = {
    at: '2026-08-31T20:12:00Z', type: 'lead-new', itemId: 'lead:qwen-tools',
    title: 'Tool call issues - Qwen3.8 27B NVFP4', detail: null, url: null,
  };
  const sameDay: CrmEvent = {
    at: '2026-08-31T20:30:00Z', type: 'stage-change', itemId: 'lead:qwen-tools',
    title: 'Tool call issues - Qwen3.8 27B NVFP4: new → skipped', detail: 'pinned by owner', url: null,
  };
  const nextDay: CrmEvent = { ...sameDay, at: '2026-09-01T01:38:00Z' };

  const ctx = signalContext([arrival, sameDay, nextDay]);
  assert.equal(eventSignal(sameDay, ctx), false, 'next to its own arrival row it is a duplicate');
  assert.equal(eventSignal(nextDay, ctx), true, 'a day later it is the only row about the item');
});

test('volume without money is signal: the ring shape spends nothing per window', () => {
  // The abuse we have actually been hit by is requests, not dollars: at list
  // prices a busy account's hourly debit rounds under the one-cent print floor,
  // so a money-only rule reads a farm as quiet.
  const usage = (title: string): CrmEvent => ({
    at: '2026-09-01T10:00:00Z', type: 'account-usage', itemId: 'tenant:t-1', title, detail: null, url: null,
  });
  assert.equal(eventSignal(usage('a@b.com: +6 req')), false, 'a handful of requests and no money is still mechanism');
  assert.equal(eventSignal(usage('a@b.com: +99 req')), false, 'just under the floor');
  assert.equal(eventSignal(usage('a@b.com: +100 req')), true, 'at the floor, money or not');
  assert.equal(eventSignal(usage('a@b.com: +4210 req')), true, 'a ring serving thousands for free is not quiet');
  assert.equal(eventSignal(usage('a@b.com: +3 req · +$0.02')), true, 'money still signals on its own');
  assert.equal(eventSignal(usage('a@b.com: +3 req · +$0.00')), false, 'a legacy zero-dollar row with no volume stays quiet');
});

test('leaving a stage that had money or traffic is signal whatever it moves to', () => {
  // Guards the catch-all rather than a reachable transition: paid never un-sets
  // today, so paying -> active cannot occur. If derivation ever changes, this
  // must not fail silent.
  const move = (title: string): CrmEvent => ({
    at: '2026-09-01T10:00:00Z', type: 'stage-change', itemId: 'tenant:t-1',
    title, detail: 'account · derived from sources', url: null,
  });
  assert.equal(eventSignal(move('a@b.com: paying → active')), true, 'a customer who stops paying without being closed');
  assert.equal(eventSignal(move('a@b.com: active → signed-up')), true, 'a trafficked account going backwards');
  assert.equal(eventSignal(move('a@b.com: signed-up → active')), false, 'the ordinary first request stays mechanism');
  assert.equal(eventSignal(move('a@b.com: signed-up → lost')), false, 'a farm sweep is still mechanism');
  assert.equal(eventSignal(move('a@b.com: active → new')), false, 'into new is the orphan-baseline flap, not a downgrade');
});
