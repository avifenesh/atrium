import test from 'node:test';
import assert from 'node:assert/strict';
import { feedRowDetail, feedRowTitle, foldFeedRows } from '../../shared/crm-feed.js';
import type { CrmEvent, CrmEventType } from '../../shared/types.js';

// The fold prints several rows as one line, and a fold that drops a number is
// worse than no fold at all: money landing is the whole reason the feed exists.
// These pin what a folded line still has to carry, and which rows are allowed to
// share one. Shapes are copied out of the real ledger (the 2026-08-31 farm sweep,
// the nivision usage rows, the double-fired langflow do-launch).

const ev = (over: Partial<CrmEvent> & { at: string; type: CrmEventType; title: string }): CrmEvent => ({
  itemId: null,
  detail: null,
  url: null,
  ...over,
});

test('a bulk sweep is one line, even when its accounts share no handle', () => {
  // The owner suspends 90 accounts in one act and they land on one timestamp.
  // Distinct domains on purpose: no identity fold can see this run, and 90 lines
  // of the same sentence is how a real suspension gets lost.
  const rows = foldFeedRows(
    Array.from({ length: 90 }, (_, i) => ev({
      at: '2026-08-31T12:12:16.337Z',
      type: 'stage-change',
      itemId: `tenant:t-${i}`,
      title: `f${i}@d${i}.example: signed-up → lost`,
      detail: 'account · derived from sources',
    })),
  );
  assert.equal(rows.length, 1, 'one act is one row');
  assert.equal(rows[0].count, 90);
  assert.equal(feedRowTitle(rows[0], 'stage'), 'stage x90, signed-up → lost');
  assert.match(feedRowDetail(rows[0]) ?? '', /and 87 more$/u);
});

test('a move into paying never folds across identities', () => {
  // Two customers starting to pay four minutes apart are two facts. Only the
  // closing moves fold, which is why the sweep key is destination-scoped.
  const rows = foldFeedRows([
    ev({ at: '2026-09-01T10:04:00Z', type: 'stage-change', itemId: 'tenant:a', title: 'one@acme.io: active → paying' }),
    ev({ at: '2026-09-01T10:00:00Z', type: 'stage-change', itemId: 'tenant:b', title: 'two@other.example: active → paying' }),
  ]);
  assert.equal(rows.length, 2);
});

test('a folded usage run carries the sum, so money never disappears into a fold', () => {
  const rows = foldFeedRows([
    ev({
      at: '2026-08-31T13:22:16.427Z', type: 'account-usage', itemId: 'tenant:a',
      title: 'ofek@nivision.co.il: +28 req · +$0.27', detail: 'now 28 req lifetime · $0.27 spent',
    }),
    ev({
      at: '2026-08-31T13:12:16.427Z', type: 'account-usage', itemId: 'tenant:b',
      title: 'dana@nivision.co.il: +5 req · +$0.10', detail: 'now 5 req lifetime · $0.10 spent',
    }),
  ]);
  assert.equal(rows.length, 1, 'one private domain, one line');
  assert.equal(
    feedRowTitle(rows[0], 'usage'),
    'usage x2, nivision.co.il (one domain): +33 req · +$0.37',
    'both amounts are in the line the reader sees',
  );
  assert.equal(feedRowDetail(rows[0]), 'ofek@nivision.co.il · dana@nivision.co.il');
});

test('a usage run nobody can add up does not fold', () => {
  const rows = foldFeedRows([
    ev({ at: '2026-08-31T13:22:00Z', type: 'account-usage', itemId: 'tenant:a', title: 'ofek@nivision.co.il: +28 req · +$0.27' }),
    ev({ at: '2026-08-31T13:12:00Z', type: 'account-usage', itemId: 'tenant:b', title: 'dana@nivision.co.il: usage recorded' }),
  ]);
  assert.equal(rows.length, 2, 'a member with no readable delta would take the sum down with it');
});

test('one handle is one line per day, with unrelated rows in between', () => {
  const rows = foldFeedRows([
    ev({ at: '2026-08-31T18:00:00Z', type: 'account-usage', itemId: 'tenant:1', title: 'a@asashi.my.id: +16 req' }),
    ev({ at: '2026-08-31T14:00:00Z', type: 'account-usage', itemId: 'tenant:9', title: 'ofek@nivision.co.il: +28 req · +$0.27' }),
    ev({ at: '2026-08-31T10:00:00Z', type: 'account-usage', itemId: 'tenant:2', title: 'b@asashi.my.id: +61 req' }),
    ev({ at: '2026-08-31T09:00:00Z', type: 'account-usage', itemId: 'tenant:3', title: 'c@asashi.my.id: +9 req' }),
  ]);
  assert.equal(rows.length, 2, 'the farm printed three times a day when the fold was consecutive-only');
  assert.equal(rows[0].count, 3, 'ordered by the run newest member, so the farm still leads');
  assert.equal(feedRowTitle(rows[0], 'usage'), 'usage x3, asashi.my.id (one domain): +86 req');
  assert.equal(rows[1].count, 1);
  assert.equal(feedRowTitle(rows[1], 'usage'), 'ofek@nivision.co.il: +28 req · +$0.27');
});

test('plus tags on one private domain name the mailbox, not the domain', () => {
  const rows = foldFeedRows([
    ev({ at: '2026-08-31T18:00:00Z', type: 'account-new', itemId: 'tenant:1', title: 'signup: dev+two@acme.io' }),
    ev({ at: '2026-08-31T17:00:00Z', type: 'account-new', itemId: 'tenant:2', title: 'signup: dev+one@acme.io' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(feedRowTitle(rows[0], 'signup'), 'signup x2, dev@acme.io (one mailbox)');
});

test('"and N more" counts addresses, not events', () => {
  const one = foldFeedRows(
    [13, 12, 11, 10].map((h) => ev({
      at: `2026-08-31T${h}:00:00Z`,
      type: 'account-usage',
      itemId: 'tenant:1',
      title: 'one@acme.io: +1 req',
      detail: 'now 4 req lifetime · $0.00 spent',
    })),
  );
  assert.equal(one.length, 1);
  assert.equal(one[0].count, 4);
  assert.equal(
    feedRowDetail(one[0]),
    'now 4 req lifetime · $0.00 spent',
    'four rows about one address asserted three addresses that do not exist',
  );

  const five = foldFeedRows(
    ['e', 'd', 'c', 'b', 'a'].map((n, i) => ev({
      at: `2026-08-31T1${5 - i}:00:00Z`,
      type: 'account-usage',
      itemId: `tenant:${n}`,
      title: `${n}@acme.io: +1 req`,
    })),
  );
  assert.equal(feedRowDetail(five[0]), 'e@acme.io · d@acme.io · c@acme.io and 2 more');
});

test('a double-fired do-launch is one row: same item, same type, seconds apart', () => {
  const rows = foldFeedRows([
    ev({ at: '2026-09-01T01:37:58.417Z', type: 'do-launched', itemId: 'direction:langflow', title: 'do: prepare a patch' }),
    ev({ at: '2026-09-01T01:37:09.238Z', type: 'do-launched', itemId: 'direction:langflow', title: 'do: prepare a patch' }),
  ]);
  assert.equal(rows.length, 1, 'a non-tenant id has no handle, so identity could not see the duplicate');
  assert.equal(feedRowTitle(rows[0], 'do'), 'do x2, do: prepare a patch');
});

test('the same item acted on twice hours apart stays two rows', () => {
  const rows = foldFeedRows([
    ev({ at: '2026-09-01T09:00:00Z', type: 'do-launched', itemId: 'direction:langflow', title: 'do: prepare a patch' }),
    ev({ at: '2026-09-01T01:37:09Z', type: 'do-launched', itemId: 'direction:langflow', title: 'do: prepare a patch' }),
  ]);
  assert.equal(rows.length, 2, 'two decisions, not a double fire');
});
