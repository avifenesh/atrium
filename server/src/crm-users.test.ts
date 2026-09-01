import test from 'node:test';
import assert from 'node:assert/strict';
import { groupUsersByMailbox, type UserMetrics, type UserRow } from '../../shared/crm-users.js';

// The users table's fold decides which rows the owner reads as one customer, and
// a collapsed group is the only place its members' money is shown. So these pin
// two things: which accounts are allowed to share a row (the mailbox fold, never
// a public-provider domain), and that every number a member carried is still in
// the row that replaced it.
//
// Addresses are the real ones off the CRM: the six accounts on the owner's own
// gmail mailbox, whose two live rows read 3 req / 3 today / $0.00 / $5.00 and
// 5 req / 3 today / $0.00 / $0.00.

const metrics = (over: Partial<UserMetrics> = {}): UserMetrics => ({
  requests: 0,
  spentMicro: 0,
  balanceMicro: null,
  requestsToday: null,
  lastActiveDay: null,
  paid: false,
  ...over,
});

const account = (title: string, over: Partial<UserMetrics> = {}): UserRow => ({
  id: `tenant:${title}`,
  title,
  metrics: metrics(over),
});

const labels = (rows: UserRow[]): string[] => groupUsersByMailbox(rows).map((g) => g.label);

test('plus tags on one mailbox are one row, named by the mailbox', () => {
  const groups = groupUsersByMailbox([
    account('danimsibads+tiy178825@gmail.com'),
    account('danimsibads@gmail.com'),
    account('danimsibads+tv2178825970787205822@gmail.com'),
  ]);
  assert.equal(groups.length, 1, 'three plus-tagged signups are one person');
  assert.equal(groups[0].label, 'danimsibads@gmail.com');
  assert.equal(groups[0].mailbox, 'danimsibads@gmail.com');
  assert.equal(groups[0].accounts, 3);
  assert.deepEqual(
    groups[0].members.map((m) => m.title),
    ['danimsibads+tiy178825@gmail.com', 'danimsibads@gmail.com', 'danimsibads+tv2178825970787205822@gmail.com'],
    'every member is still reachable, in the order it arrived',
  );
});

test('gmail dots fold into the same row as the undotted local', () => {
  const groups = groupUsersByMailbox([
    account('dani.msib.ads@gmail.com'),
    account('danimsibads+x@gmail.com'),
  ]);
  assert.equal(groups.length, 1, 'gmail ignores dots, so these are one mailbox');
  assert.equal(groups[0].label, 'danimsibads@gmail.com');
});

test('googlemail folds by the same rule, and is not merged into gmail', () => {
  assert.deepEqual(
    labels([account('d.ani+one@googlemail.com'), account('dani@googlemail.com')]),
    ['dani@googlemail.com'],
    'googlemail is dot-blind too',
  );
  assert.equal(
    groupUsersByMailbox([account('dani@googlemail.com'), account('dani@gmail.com')]).length,
    2,
    'the fold never rewrites a domain, so these stay two rows',
  );
});

test('a private domain does not dot-fold: those are two different people', () => {
  const groups = groupUsersByMailbox([account('a.b@nivision.co.il'), account('ab@nivision.co.il')]);
  assert.equal(groups.length, 2, 'dots are significant off the dot-blind providers');
  assert.deepEqual(groups.map((g) => g.label).sort(), ['a.b@nivision.co.il', 'ab@nivision.co.il']);
  assert.deepEqual(groups.map((g) => g.accounts), [1, 1]);
});

test('two locals on one public provider are two people, never one row', () => {
  // The law this pins: a gmail cluster means nothing (the whole internet has a
  // gmail address), so only the MAILBOX fold may group accounts here. Folding on
  // the shared domain would bury a real customer inside a stranger's row.
  const groups = groupUsersByMailbox([
    account('ofek@gmail.com'),
    account('dana@gmail.com'),
    account('someone@outlook.com'),
    account('other@outlook.com'),
  ]);
  assert.equal(groups.length, 4, 'four strangers, four rows');
  assert.deepEqual(groups.map((g) => g.accounts), [1, 1, 1, 1]);
});

test('a private domain is a team, not a person: it stays unfolded here', () => {
  // The domain pile is real signal, and it is named on the security page. It is
  // not an identity, so it must not collapse a colleague into a coworker's row.
  const groups = groupUsersByMailbox([account('ofek@nivision.co.il'), account('dana@nivision.co.il')]);
  assert.equal(groups.length, 2);
});

test('a folded row carries every number its members had', () => {
  const groups = groupUsersByMailbox([
    account('danimsibads+tiy178825@gmail.com', {
      requests: 3, requestsToday: 3, spentMicro: 0, balanceMicro: 5_000_000, lastActiveDay: '2026-09-01',
    }),
    account('danimsibads@gmail.com', {
      requests: 5, requestsToday: 3, spentMicro: 270_000, balanceMicro: 0, lastActiveDay: '2026-08-20',
    }),
    account('dani.msibads+old@gmail.com', {
      requests: 1, requestsToday: 0, spentMicro: 30_000, balanceMicro: 1_000_000, lastActiveDay: '2026-08-14', paid: true,
    }),
  ]);
  assert.equal(groups.length, 1);
  const { totals, accounts } = groups[0];
  assert.equal(accounts, 3);
  assert.equal(totals.requests, 9, 'lifetime requests sum');
  assert.equal(totals.requestsToday, 6, "today's requests sum");
  assert.equal(totals.spentMicro, 300_000, 'spend sums, so a fold cannot swallow money');
  assert.equal(totals.balanceMicro, 6_000_000, 'credit left sums, in micro-dollars');
  assert.equal(totals.paid, true, 'one member bought, so the row says the mailbox has paid');
});

test('the newest last-active in the group wins', () => {
  // Oldest member FIRST on purpose: a fold that kept the first day it saw would
  // report a live mailbox as five months quiet, which is an email nobody should
  // get.
  const groups = groupUsersByMailbox([
    account('dev+one@acme.io', { requests: 2, lastActiveDay: '2026-04-02' }),
    account('dev+two@acme.io', { requests: 1, lastActiveDay: '2026-09-01' }),
    account('dev+three@acme.io', { requests: 1, lastActiveDay: '2026-08-14' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].totals.lastActiveDay, '2026-09-01');
});

test('a lone account is one group of one, with its own numbers untouched', () => {
  const groups = groupUsersByMailbox([
    account('ofek@nivision.co.il', { requests: 28, spentMicro: 270_000, balanceMicro: 4_730_000, requestsToday: 4, lastActiveDay: '2026-09-01' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].accounts, 1, 'no expander, because there is nothing to expand');
  assert.equal(groups[0].members.length, 1);
  assert.deepEqual(
    groups[0].totals,
    groups[0].members[0].metrics,
    'a group of one reports exactly what the account reports',
  );
});

test('an unknown balance never blanks the balance the group does know', () => {
  const partial = groupUsersByMailbox([
    account('dev+one@acme.io', { balanceMicro: null }),
    account('dev+two@acme.io', { balanceMicro: 5_000_000 }),
  ]);
  assert.equal(partial[0].totals.balanceMicro, 5_000_000, 'the money that IS reported still prints');

  const none = groupUsersByMailbox([
    account('dev+one@acme.io', { balanceMicro: null }),
    account('dev+two@acme.io', { balanceMicro: null }),
  ]);
  assert.equal(none[0].totals.balanceMicro, null, 'nothing reported stays unknown, not a confident zero');
});

test('no report today is not zero requests today', () => {
  const unreported = groupUsersByMailbox([
    account('dev+one@acme.io', { requestsToday: null }),
    account('dev+two@acme.io', { requestsToday: null }),
  ]);
  assert.equal(unreported[0].totals.requestsToday, null, 'the report was unavailable, so the cell has no number');

  const mixed = groupUsersByMailbox([
    account('dev+one@acme.io', { requestsToday: null }),
    account('dev+two@acme.io', { requestsToday: 0 }),
    account('dev+three@acme.io', { requestsToday: 2 }),
  ]);
  assert.equal(mixed[0].totals.requestsToday, 2);
});

test('a title the fold cannot read keeps its own row', () => {
  const groups = groupUsersByMailbox([
    { id: 'tenant:a', title: 'root@localhost', metrics: metrics({ requests: 4 }) },
    { id: 'tenant:b', title: 'root@localhost', metrics: metrics({ requests: 7 }) },
    { id: 'tenant:c', title: 'not-an-address', metrics: null },
  ]);
  assert.equal(groups.length, 3, 'two identical unreadable titles are not evidence of one person');
  assert.deepEqual(groups.map((g) => g.key), ['account:tenant:a', 'account:tenant:b', 'account:tenant:c']);
  assert.deepEqual(groups.map((g) => g.mailbox), [null, null, null]);
  assert.equal(groups[2].totals.requests, 0, 'an account with no metrics contributes nothing and breaks nothing');
});

test('groups come back in first-appearance order, so the caller owns the sort', () => {
  assert.deepEqual(
    labels([
      account('zoe@acme.io'),
      account('danimsibads+a@gmail.com'),
      account('ann@other.example'),
      account('danimsibads+b@gmail.com'),
    ]),
    ['zoe@acme.io', 'danimsibads@gmail.com', 'ann@other.example'],
    'a later member joins its group where the group first appeared',
  );
});
