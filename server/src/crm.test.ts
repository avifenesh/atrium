import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crm } from './crm.js';
import { store } from './state.js';
import type { SignalItem, SignalsState } from '../../shared/types.js';

// The pipeline is assembled, not stored: signals and console accounts stay live
// while the owner's stage/notes/follow-ups overlay them. These pin the merge
// rules — derived stages, manual override, the contact-log auto-advance, orphan
// retention — because each one silently rewrites the funnel if it drifts.

function signal(id: string, kind: SignalItem['kind'], lead?: SignalItem['lead'], title?: string): SignalItem {
  return {
    id, kind, source: 'hn', entity: 'memra',
    title: title ?? 'we run agents in production and are looking for a cheaper provider',
    detail: null,
    url: `https://example.com/${id}`, count: null, delta: null,
    occurredAt: '2026-08-19T00:00:00Z', firstSeenAt: '2026-08-19T00:00:00Z',
    ...(lead ? { lead } : {}),
  };
}

function seedStore(items: SignalItem[], accounts: unknown[]): void {
  const signals: SignalsState = {
    updatedAt: null, items, lastReviewedAt: null, sources: [], error: null,
    watch: { terms: [], radarWatch: [], demandKeywords: [], prospectKeywords: [],
    disqualifyKeywords: [], buyerQueries: [], repos: [], hfModels: [], crates: [] },
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
    assert.equal(byId.get('s-engaged')?.derivedStage, 'contacted');
    // dismissed = triaged away without engaging — a skip, not a loss
    assert.equal(byId.get('s-dismissed')?.stage, 'skipped');
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

test('contacted is a logged touch, not an empty pin or an engaged flag', async () => {
  await withCrm(async () => {
    seedStore(
      [
        signal('s-engaged', 'mention', { status: 'engaged', note: null, updatedAt: '2026-08-19T00:00:00Z' }),
        signal('s-pinned', 'prospect-thread'),
      ],
      [],
    );
    await crm.update('s-pinned', { stage: 'contacted' });
    let byId = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(byId.get('s-engaged')?.stage, 'contacted', 'a self-comment (engaged) is contacted');
    assert.equal(byId.get('s-pinned')?.stage, 'contacted', 'tapping commented is an owner pin and must stick');
    assert.equal(byId.get('s-pinned')?.contacts.length, 1);

    await crm.addContact('s-engaged', 'x', 'replied on the thread');
    byId = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(byId.get('s-engaged')?.stage, 'contacted');
    assert.equal(byId.get('s-engaged')?.contacts.length, 1);
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

test('score-0 leads stay off the board unless the owner already touched them', async () => {
  await withCrm(async () => {
    seedStore(
      [
        signal('s-zero', 'prospect-thread', undefined, 'weekly release notes for the kernel'),
        signal('s-real', 'prospect-thread'),
      ],
      [],
    );
    const signals = store.get().signals;
    signals.items.push({
      ...signal('s-own', 'prospect-thread', undefined, 'does the tokenizer match the card?'),
      entity: 'own card · qwen3-8b',
      source: 'hf-hub',
    });
    store.setSection('signals', signals);

    let byId = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(byId.has('s-zero'), false);
    assert.equal(byId.get('s-real')?.relevance?.qualified, true);
    assert.equal(byId.has('s-own'), true);

    await crm.addNote('s-zero', 'worth a look despite the score');
    byId = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(byId.get('s-zero')?.notes[0]?.text, 'worth a look despite the score');
    assert.ok((byId.get('s-zero')?.relevance?.score ?? 1) <= 0);

    seedStore(
      [signal('s-engaged-zero', 'mention', { status: 'engaged', note: 'auto: avi commented', updatedAt: '2026-08-19T00:00:00Z' }, 'weekly release notes for the kernel')],
      [],
    );
    const engaged = crm.pipeline().items.find((i) => i.id === 's-engaged-zero');
    assert.equal(engaged?.stage, 'contacted');
    assert.ok((engaged?.relevance?.score ?? 1) <= 0);

    seedStore(
      [signal('s-skip', 'prospect-thread', undefined, 'weekly release notes for the kernel')],
      [],
    );
    await crm.update('s-skip', { stage: 'skipped' });
    assert.equal(crm.pipeline().items.some((i) => i.id === 's-skip'), false);
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
    await assert.rejects(() => crm.update('x', { action: { brief: 'no label' } }), /action.label/);
  });
});

// The churn flag exists to say "an established customer stopped calling".
// Emailing them is the response to it, so the flag has to stop firing once that
// happened — a warn that survives the action it asked for is noise, and a strip
// full of noise is a strip nobody reads.
test('a quiet-customer flag clears once the customer has been contacted', async () => {
  await withCrm(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const longAgo = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
    seedStore([], [account('t-quiet', { requests: 40, lastActiveDay: longAgo })]);

    await crm.update('t-noop', { followUpAt: null }); // force a flag pass
    assert.ok(
      store.get().flags.some((f) => f.id === 'crm:quiet:tenant:t-quiet'),
      'a customer silent for 9 days should raise the churn flag',
    );

    await crm.addContact('tenant:t-quiet', 'email', 'asked what made them stop');
    await crm.update('t-noop', { followUpAt: null }); // re-run the flag pass
    assert.equal(
      store.get().flags.some((f) => f.id === 'crm:quiet:tenant:t-quiet'),
      false,
      'the ball is in their court now — the follow-up date is the nag, not the flag',
    );
    assert.notEqual(today, longAgo);
  });
});

test('directions: files become pipeline rows with detail, and overlay state sticks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-crm-dirs-'));
  crm._resetForTest(join(dir, 'crm.json'), dir);
  try {
    seedStore([], []);
    await writeFile(join(dir, 'discord-llm-servers.json'), JSON.stringify({
      slug: 'discord-llm-servers',
      title: 'Answer capacity questions in LLM Discord servers',
      why: 'three servers asked for Qwen3.8 hosts this week',
      firstAction: 'join r/LocalLLaMA discord, watch #hosting for a day',
      segment: 'hobbyist-to-paid',
      urls: ['https://example.com/discord'],
      createdAt: '2026-08-20T00:00:00Z',
    }));
    await writeFile(join(dir, 'broken.json'), '{"title":"no slug"}'); // must be skipped, not crash
    await crm._refreshDirectionsForTest();

    const pipeline = crm.pipeline();
    const item = pipeline.items.find((i) => i.id === 'direction:discord-llm-servers');
    assert.equal(item?.kind, 'direction');
    assert.equal(item?.source, 'seller');
    assert.equal(item?.stage, 'new');
    assert.match(item?.detail ?? '', /three servers/);
    assert.equal(item?.detail?.includes('join r/LocalLLaMA'), false, 'firstAction is the stuck do-link, not buried in detail');
    assert.equal(item?.action?.label.startsWith('do join r/LocalLLaMA'), true);
    assert.equal(item?.action?.href, 'https://example.com/discord');
    assert.equal(pipeline.items.some((i) => i.title === 'no slug'), false);

    // owner overlay works on directions like any other id
    await crm.addContact('direction:discord-llm-servers', 'discord', 'joined, watching');
    assert.equal(crm.pipeline().items.find((i) => i.id === 'direction:discord-llm-servers')?.stage, 'contacted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The users screen reads these fields directly instead of parsing the formatted `detail` string.
// Before they existed, balance and last-active survived only inside prose, so nothing could sort or
// filter on them. If they stop being populated the page silently shows em dashes for every row.
test('account items carry the metrics the users screen sorts on', async () => {
  await withCrm(async () => {
    seedStore([], [
      account('ten_rich', {
        requests: 120, spentMicro: 2_500_000, creditedMicro: 10_000_000,
        lastActiveDay: '2026-08-24', signupRef: 'x', paid: true,
      }),
      account('ten_fresh'),
    ]);
    await crm.load();
    const items = crm.pipeline().items;

    const rich = items.find((i) => i.id === 'tenant:ten_rich');
    assert.ok(rich?.metrics, 'an account item must carry metrics');
    assert.equal(rich.metrics.requests, 120);
    assert.equal(rich.metrics.spentMicro, 2_500_000);
    assert.equal(rich.metrics.creditedMicro, 10_000_000);
    // Balance is derived, not reported: credited minus spent.
    assert.equal(rich.metrics.balanceMicro, 7_500_000);
    assert.equal(rich.metrics.lastActiveDay, '2026-08-24');
    assert.equal(rich.metrics.signupRef, 'x');
    assert.equal(rich.metrics.paid, true);
    assert.equal(rich.metrics.suspended, false);
    assert.equal(rich.metrics.enrolled, true);

    // An account the console reported no credit total for must read as unknown, never as zero:
    // "$0.00 balance" and "we do not know the balance" are different facts.
    const fresh = items.find((i) => i.id === 'tenant:ten_fresh');
    assert.equal(fresh?.metrics?.creditedMicro, null);
    assert.equal(fresh?.metrics?.balanceMicro, null);
    assert.equal(fresh?.metrics?.requests, 0);
  });
});

// "How many requests did this user make TODAY" comes from the console activity
// report, not the lifetime counter. The join must distinguish three states:
// account active today (N), report present but account silent (0), report
// unavailable (null) — a null rendered as 0 would say "nobody called" during an
// activity outage.
test('account metrics join today figures from the activity report, null when absent', async () => {
  await withCrm(async () => {
    seedStore([], [account('t-busy'), account('t-idle'), account('t-broken'), account('t-capped')]);
    const today = new Date().toISOString().slice(0, 10);
    const state = store.get().extra['tiyuvta']!;
    store.setExtra('tiyuvta', {
      ...state,
      data: {
        ...(state.data as Record<string, unknown>),
        activity: {
          days: 14,
          errors: [{ tenantId: 't-broken', engine: 'q38', code: 'engine_unreachable' }],
          tenants: [
            {
              tenantId: 't-busy',
              // totals is the cross-box mirror truth; day rows are live journal
              // exports that under-report after a box move — the window figure
              // must come from totals (217-read-as-8 incident, 2026-08-30)
              totals: { requests: 217, debitedMicro: 900_000 },
              days: [
                { day: today, engine: 'q38', requests: 41, debitedMicro: 310_000 },
                { day: '2020-01-01', engine: 'q38', requests: 9, debitedMicro: 50_000 },
              ],
            },
            // fan-out leg failed: day data is UNKNOWN, never zero
            { tenantId: 't-broken', totals: { requests: 12, debitedMicro: 10_000 }, days: [] },
            // past the fan-out cap: window traffic exists but no day rows shipped
            { tenantId: 't-capped', totals: { requests: 30, debitedMicro: 20_000 }, days: [] },
          ],
        },
      },
    });

    const byId = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(byId.get('tenant:t-busy')?.metrics?.requestsToday, 41);
    assert.equal(byId.get('tenant:t-busy')?.metrics?.debitedTodayMicro, 310_000);
    assert.equal(byId.get('tenant:t-busy')?.metrics?.requestsWindow, 217, 'window = mirror totals, not the day-row sum');
    // report present, tenant absent from it → a real zero
    assert.equal(byId.get('tenant:t-idle')?.metrics?.requestsToday, 0);
    // failed fan-out leg → unknown, not a lying zero
    assert.equal(byId.get('tenant:t-broken')?.metrics?.requestsToday, null);
    assert.equal(byId.get('tenant:t-broken')?.metrics?.requestsWindow, 12);
    // capped out of the fan-out: window traffic with no day rows → today unknown
    assert.equal(byId.get('tenant:t-capped')?.metrics?.requestsToday, null);
    assert.equal(byId.get('tenant:t-capped')?.metrics?.requestsWindow, 30);

    // report unavailable → null, never zero
    store.setExtra('tiyuvta', state);
    const without = new Map(crm.pipeline().items.map((i) => [i.id, i]));
    assert.equal(without.get('tenant:t-busy')?.metrics?.requestsToday, null);
  });
});

// The pipeline board renders one column per PIPELINE_STAGES entry. That set is only correct while the
// server cannot put a lead or a direction into an account-only stage. This pins the server half of
// that contract: if derivedLeadStage ever starts returning 'signed-up' / 'active' / 'paying', the
// board would silently stop showing those rows and this fails instead.
test('leads and directions never derive an account-only stage', async () => {
  await withCrm(async () => {
    const ACCOUNT_ONLY = new Set(['signed-up', 'active', 'paying']);
    seedStore(
      [
        signal('s-new', 'mention'),
        signal('s-engaged', 'mention', { status: 'engaged', note: null, updatedAt: '2026-08-19T00:00:00Z' }),
        signal('s-dismissed', 'mention', { status: 'dismissed', note: null, updatedAt: '2026-08-19T00:00:00Z' }),
      ],
      // An account in every lifecycle state, to prove the account side DOES use them.
      [
        account('ten_signedup'),
        account('ten_active', { requests: 9 }),
        account('ten_paying', { paid: true }),
      ],
    );
    await crm.load();
    const items = crm.pipeline().items;

    for (const item of items) {
      if (item.kind === 'account') continue;
      assert.ok(
        !ACCOUNT_ONLY.has(item.derivedStage),
        `${item.kind} ${item.id} derived an account-only stage: ${item.derivedStage}`,
      );
    }

    // And the account side genuinely populates them, so the stages are not dead overall.
    const accountStages = new Set(
      items.filter((i) => i.kind === 'account').map((i) => i.derivedStage),
    );
    assert.ok(accountStages.has('signed-up'), 'an account should reach signed-up');
    assert.ok(accountStages.has('active'), 'an account should reach active');
    assert.ok(accountStages.has('paying'), 'an account should reach paying');
  });
});

test('stuck action: overlay wins over a direction firstAction; leads stay empty until researched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-crm-action-'));
  crm._resetForTest(join(dir, 'crm.json'), dir);
  try {
    seedStore([signal('s-lead', 'prospect-thread'), signal('s-draft', 'prospect-thread')], []);
    await writeFile(join(dir, 'discord-llm-servers.json'), JSON.stringify({
      slug: 'discord-llm-servers',
      title: 'Answer capacity questions in LLM Discord servers',
      why: 'three servers asked',
      firstAction: 'join the server and watch',
      segment: 'hobbyist-to-paid',
      urls: ['https://example.com/discord'],
      createdAt: '2026-08-20T00:00:00Z',
    }));
    await crm._refreshDirectionsForTest();

    const lead = crm.pipeline().items.find((i) => i.id === 's-lead');
    assert.equal(lead?.action, null);

    await crm.addNote('s-draft', 'outreach draft (seller):\nYou need Qwen3.8 27B. I serve that.');
    const drafted = crm.pipeline().items.find((i) => i.id === 's-draft');
    assert.equal(drafted?.action?.label, 'do send the outreach draft');
    assert.match(drafted?.action?.brief ?? '', /You need Qwen3.8 27B/);
    await crm.update('s-draft', {
      action: {
        label: 'do draft a reply on X — leftover ingest',
        brief: 'Qualify against companies/heavy-users.',
        href: 'https://example.com/s-draft',
      },
    });
    assert.equal(crm.pipeline().items.find((i) => i.id === 's-draft')?.action?.label, 'do send the outreach draft');

    await crm.update('s-lead', {
      action: {
        label: 'do qualify and draft a reply — t-s-lead',
        brief: 'Read the thread. Qualify against companies/heavy-users and always-on agents.',
        href: 'https://example.com/s-lead',
      },
    });
    assert.equal(crm.pipeline().items.find((i) => i.id === 's-lead')?.action, null);

    await crm.update('direction:discord-llm-servers', {
      action: { label: 'do draft a mail to the server ops', brief: 'Open on their hosting thread.', href: 'https://example.com/mail' },
    });
    const direction = crm.pipeline().items.find((i) => i.id === 'direction:discord-llm-servers');
    assert.equal(direction?.action?.label, 'do draft a mail to the server ops');
    assert.equal(direction?.action?.href, 'https://example.com/mail');

    await crm.update('s-lead', { action: { label: 'do reply on the HN thread', href: 'https://example.com/s-lead' } });
    const prompted = await crm.doPrompt('s-lead', {
      generatedAt: '2026-08-29T00:00:00Z',
      stateBrief: 'Accounts: 2 with purchase',
      stateBriefPath: 'test/state-brief.md',
      productMarketing: 'Prepaid LLM inference API. Never offer trial credit.',
      productMarketingPath: 'test/product-marketing.md',
    });
    assert.match(prompted.prompt, /VERIFIED FACTS you must weigh/);
    assert.match(prompted.prompt, /Accounts: 2 with purchase/);
    assert.match(prompted.prompt, /do reply on the HN thread/);
    assert.match(prompted.prompt, /s-lead/);
    assert.match(prompted.prompt, /Never offer trial credit/);

    await assert.rejects(() => crm.doPrompt('s-missing'), /unknown item/);
    await crm.update('s-lead', { action: null });
    await assert.rejects(() => crm.doPrompt('s-lead'), /no action/);

    // An owner label that happens to open like an ingest template must stick: the
    // placeholder filter reads the template brief, not the label, or a saved action
    // disappears from the card with a 200 and do-prompt then says 'item has no action'.
    await crm.update('s-lead', {
      action: {
        label: 'do draft a reply on X about their OpenRouter bill',
        brief: 'Open on the $40k line they quoted. Destination: their thread. Draft only.',
        href: 'https://example.com/s-lead',
      },
    });
    const kept = crm.pipeline().items.find((i) => i.id === 's-lead');
    assert.equal(kept?.action?.label, 'do draft a reply on X about their OpenRouter bill');
    assert.match((await crm.doPrompt('s-lead')).prompt, /their OpenRouter bill/);

    // The outreach-draft action is synthesized on every assemble(), so its stamp has
    // to come from the source note. An iso() default churned updatedAt once a second
    // and reset the owner's half-typed brief in the editor at every 60s poll.
    const draftStamp = crm.pipeline().items.find((i) => i.id === 's-draft')?.action?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(crm.pipeline().items.find((i) => i.id === 's-draft')?.action?.updatedAt, draftStamp);

  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
