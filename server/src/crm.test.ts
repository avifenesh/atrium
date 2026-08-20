import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crm } from './crm.js';
import { store } from './state.js';
import type { SignalItem, SignalsState } from '../../shared/types.js';

// The pipeline is assembled, not stored: signals and console accounts stay live
// while the owner's stage/notes/follow-ups overlay them. These pin the merge
// rules — derived stages, manual override, the contact-log auto-advance, orphan
// retention — because each one silently rewrites the funnel if it drifts.

function signal(id: string, kind: SignalItem['kind'], lead?: SignalItem['lead']): SignalItem {
  return {
    id, kind, source: 'hn', entity: 'memra', title: `t-${id}`, detail: null,
    url: `https://example.com/${id}`, count: null, delta: null,
    occurredAt: '2026-08-19T00:00:00Z', firstSeenAt: '2026-08-19T00:00:00Z',
    ...(lead ? { lead } : {}),
  };
}

function seedStore(items: SignalItem[], accounts: unknown[]): void {
  const signals: SignalsState = {
    updatedAt: null, items, lastReviewedAt: null, sources: [], error: null,
    watch: { terms: [], radarWatch: [], demandKeywords: [], prospectKeywords: [], repos: [], hfModels: [], crates: [] },
  };
  store.setSection('signals', signals);
  store.setExtra('tiyuvta', { updatedAt: null, data: { dashboard: { top: accounts } } });
}

async function withCrm(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-crm-test-'));
  crm._resetForTest(join(dir, 'crm.json'));
  try {
    await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const account = (tenantId: string, over: Record<string, unknown> = {}) => ({
  email: `${tenantId}@example.com`, tenantId, requests: 0, spentMicro: 0,
  paid: false, enrolled: true, suspended: false, internal: false, lastActiveDay: null, ...over,
});

test('derives stages: lead states and account states map onto one funnel', async () => {
  await withCrm(async () => {
    seedStore(
      [
        signal('s-new', 'prospect-thread'),
        signal('s-engaged', 'mention', { status: 'engaged', note: null, updatedAt: '2026-08-19T00:00:00Z' }),
        signal('s-dismissed', 'demand-thread', { status: 'dismissed', note: null, updatedAt: '2026-08-19T00:00:00Z' }),
        signal('s-counter', 'counter'), // not a person — never pipeline
      ],
      [
        account('t-fresh'),
        account('t-active', { requests: 5 }),
        account('t-paying', { requests: 9, paid: true }),
        account('t-gone', { suspended: true }),
        account('t-bench', { requests: 700, internal: true }), // owner traffic — excluded
      ],
    );

    const byId = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(byId.get('s-new')?.stage, 'new');
    assert.equal(byId.get('s-engaged')?.stage, 'contacted');
    assert.equal(byId.get('s-dismissed')?.stage, 'lost');
    assert.equal(byId.has('s-counter'), false);
    assert.equal(byId.get('tenant:t-fresh')?.stage, 'signed-up');
    assert.equal(byId.get('tenant:t-active')?.stage, 'active');
    assert.equal(byId.get('tenant:t-paying')?.stage, 'paying');
    assert.equal(byId.get('tenant:t-gone')?.stage, 'lost');
    assert.equal(byId.has('tenant:t-bench'), false);
  });
});

test('manual stage overrides the derived one and says so; null restores it', async () => {
  await withCrm(async () => {
    seedStore([], [account('t-churny', { requests: 8, paid: true })]);

    await crm.update('tenant:t-churny', { stage: 'lost' });
    let item = crm.pipeline().items.find((i) => i.id === 'tenant:t-churny');
    assert.equal(item?.stage, 'lost');
    assert.equal(item?.derivedStage, 'paying');
    assert.equal(item?.overridden, true);

    await crm.update('tenant:t-churny', { stage: null });
    item = crm.pipeline().items.find((i) => i.id === 'tenant:t-churny');
    assert.equal(item?.stage, 'paying');
    assert.equal(item?.overridden, false);
  });
});

test('logging a contact advances a new lead to contacted, but never pins an account', async () => {
  await withCrm(async () => {
    seedStore([signal('s-lead', 'prospect-thread')], [account('t-cust', { requests: 3 })]);

    await crm.addContact('s-lead', 'gh-comment', 'answered their OOM thread');
    await crm.addContact('tenant:t-cust', 'email', 'asked how onboarding went');

    const byId = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(byId.get('s-lead')?.stage, 'contacted');
    assert.equal(byId.get('s-lead')?.contacts.length, 1);
    // the account keeps deriving from the console — the touch is logged, not the stage
    assert.equal(byId.get('tenant:t-cust')?.stage, 'active');
    assert.equal(byId.get('tenant:t-cust')?.overridden, false);
  });
});

test('a due follow-up sorts first, flags through the flag pipe, and clears', async () => {
  await withCrm(async () => {
    seedStore([signal('s-a', 'mention'), signal('s-b', 'mention')], []);

    await crm.update('s-b', { followUpAt: '2020-01-01T00:00:00Z' });
    const pipeline = crm.pipeline();
    assert.equal(pipeline.items[0]?.id, 's-b');
    assert.equal(pipeline.items[0]?.followUpDue, true);
    assert.ok(store.get().flags.some((f) => f.id === 'crm:follow-up:s-b'));

    await crm.update('s-b', { followUpAt: null });
    assert.ok(!store.get().flags.some((f) => f.id === 'crm:follow-up:s-b'));
  });
});

test('owner state outlives its source item instead of vanishing with it', async () => {
  await withCrm(async () => {
    seedStore([signal('s-temp', 'demand-thread')], []);
    await crm.addNote('s-temp', 'they wanted nvfp4 for a 5090');

    seedStore([], []); // the signal ages out of every feed
    const pipeline = crm.pipeline();
    assert.deepEqual(pipeline.orphaned, ['s-temp']);
    const item = pipeline.items.find((i) => i.id === 's-temp');
    assert.equal(item?.notes[0]?.text, 'they wanted nvfp4 for a 5090');
  });
});

test('rejects garbage: unknown stage, bad date, empty note', async () => {
  await withCrm(async () => {
    seedStore([], []);
    await assert.rejects(() => crm.update('x', { stage: 'won' }), /invalid stage/);
    await assert.rejects(() => crm.update('x', { followUpAt: 'tomorrowish' }), /ISO date/);
    await assert.rejects(() => crm.addNote('x', '   '), /note text/);
    await assert.rejects(() => crm.addContact('', 'email', 'hi'), /missing id/);
  });
});
