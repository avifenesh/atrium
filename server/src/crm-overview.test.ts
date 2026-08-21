import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crm } from './crm.js';
import { crmOverview } from './crm-overview.js';
import { store } from './state.js';
import type { SignalItem, SignalsState } from '../../shared/types.js';

// The outbound funnel is the answer to "is any of this selling working". It read
// leads only, so the highest-value touch — writing to a live user who stalled —
// did not appear in it at all, and the panel reported that nobody worth reaching
// had been reached.

function signal(id: string): SignalItem {
  return {
    id, kind: 'prospect-thread', source: 'hf-hub', entity: 'memra', title: `t-${id}`, detail: null,
    url: `https://example.com/${id}`, count: null, delta: null,
    occurredAt: '2026-08-19T00:00:00Z', firstSeenAt: '2026-08-19T00:00:00Z',
  };
}

const account = (tenantId: string, over: Record<string, unknown> = {}) => ({
  email: `${tenantId}@example.com`, tenantId, requests: 0, spentMicro: 0,
  paid: false, enrolled: true, suspended: false, internal: false, lastActiveDay: null, ...over,
});

function seedStore(items: SignalItem[], accounts: unknown[]): void {
  const signals: SignalsState = {
    updatedAt: null, items, lastReviewedAt: null, sources: [], error: null,
    watch: { terms: [], radarWatch: [], demandKeywords: [], prospectKeywords: [], repos: [], hfModels: [], crates: [] },
  };
  store.setSection('signals', signals);
  store.setExtra('tiyuvta', { updatedAt: null, data: { dashboard: { top: accounts } } });
}

async function withCrm(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-crm-overview-test-'));
  crm._resetForTest(join(dir, 'crm.json'));
  try {
    await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('outbound funnel counts an emailed customer, not just leads', async () => {
  await withCrm(async () => {
    seedStore([signal('s-lead')], [account('t-user', { requests: 260, lastActiveDay: '2026-08-21' })]);

    let out = (await crmOverview()).outbound;
    assert.equal(out.contacted, 0, 'an active account nobody wrote to is not outreach');

    await crm.addContact('tenant:t-user', 'email', 'asked what they are building');
    out = (await crmOverview()).outbound;
    assert.equal(out.contacted, 1, 'the founder email must show up in the funnel');
    assert.equal(out.replied, 0, 'being active predates the email — that is not a reply');
    assert.ok(
      out.bySource.some((row) => row.source === 'console' && row.contacted === 1),
      'the touch is attributed to the console source',
    );
  });
});

test('a reply on an account is only counted when the owner pins it', async () => {
  await withCrm(async () => {
    seedStore([], [account('t-user', { requests: 12, lastActiveDay: '2026-08-21' })]);
    await crm.addContact('tenant:t-user', 'email', 'asked what nearly stopped them');

    assert.equal((await crmOverview()).outbound.replied, 0);

    await crm.update('tenant:t-user', { stage: 'replied' });
    const out = (await crmOverview()).outbound;
    assert.equal(out.replied, 1, 'a real answer is owner-observed, so the pin is the evidence');
    assert.equal(out.contacted, 1);
  });
});

test('leads keep their existing funnel semantics', async () => {
  await withCrm(async () => {
    seedStore([signal('s-a'), signal('s-b')], []);
    await crm.addNote('s-a', 'outreach draft (seller):\nhello there');

    let out = (await crmOverview()).outbound;
    assert.equal(out.drafted, 1, 'a drafted-but-unsent lead still counts as drafted');
    assert.equal(out.contacted, 0, 'drafting is not contacting');

    await crm.addContact('s-b', 'hf-thread', 'answered their thread');
    out = (await crmOverview()).outbound;
    assert.equal(out.contacted, 1);
    assert.equal(out.drafted, 1);
  });
});
