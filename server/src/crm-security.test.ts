import test from 'node:test';
import assert from 'node:assert/strict';
import { securityPosture, type SecurityDashboard } from './crm-security.js';

// The security page's job is to be ignorable. These pin the two ways it could
// fail at that: calling a normal week suspicious, and calling a farm clear.
//
// Shapes come from the real 2026-08-31 flood: one gmail mailbox wearing plus
// tags, and 86 accounts on one private domain paced slowly enough that no single
// minute ever held three of them.

const NOW = Date.parse('2026-09-01T12:00:00Z');
const HOUR = 3_600_000;

type Top = NonNullable<SecurityDashboard['top']>[number];

const account = (email: string, over: Partial<Top> = {}): Top => ({
  email,
  tenantId: email.replace(/[^a-z0-9]/gu, ''),
  createdAt: NOW - HOUR,
  creditedMicro: 5_000_000,
  spentMicro: 0,
  requests: 0,
  suspended: false,
  enrolled: true,
  internal: false,
  ...over,
});

const dash = (top: Top[], over: Partial<SecurityDashboard> = {}): SecurityDashboard => ({
  accounts: { total: top.length, enrolled: top.length, suspended: 0, consented: 0, newToday: top.length, new7d: top.length },
  money: { grantedMicro: 5_000_000 * top.length, pendingPurchases: 0 },
  promo: { claimed: 1, seats: 200, remaining: 199 },
  top,
  ...over,
});

test('a plus-tag farm is one cluster, counted and dated', () => {
  const posture = securityPosture(
    dash([
      account('danimsibads+tv1@gmail.com', { createdAt: NOW - 4 * HOUR }),
      account('danimsibads+tv2@gmail.com', { createdAt: NOW - 3 * HOUR }),
      account('dani.msibads@gmail.com', { createdAt: NOW - 2 * HOUR, suspended: true }),
      account('someone.else@gmail.com'),
    ]),
    NOW,
  );
  assert.ok(posture);
  assert.equal(posture.mailboxes.length, 1, 'one folded mailbox is over the bar, the lone gmail is not');

  const cluster = posture.mailboxes[0];
  assert.equal(cluster.label, 'danimsibads@gmail.com');
  assert.equal(cluster.accounts, 3);
  assert.equal(cluster.suspended, 1);
  assert.equal(cluster.granted, 3, 'every member took a credit grant');
  assert.equal(cluster.grantedMicro, 15_000_000);
  assert.equal(cluster.firstSeen, new Date(NOW - 4 * HOUR).toISOString());
  assert.equal(cluster.lastSeen, new Date(NOW - 2 * HOUR).toISOString());
  assert.equal(cluster.open, true, 'two members are still live');
  assert.equal(cluster.wantsLook, true);
  assert.equal(posture.attention, 1);
});

test('a cluster whose every member is suspended is history, not attention', () => {
  const posture = securityPosture(
    dash([
      account('farm+a@gmail.com', { suspended: true }),
      account('farm+b@gmail.com', { suspended: true }),
    ]),
    NOW,
  );
  assert.equal(posture?.mailboxes.length, 1, 'it still appears on the page');
  assert.equal(posture?.mailboxes[0].open, false);
  assert.equal(posture?.mailboxes[0].wantsLook, false);
  assert.equal(posture?.attention, 0, 'the verdict reads clear once it is dealt with');
});

test('gmail is never a domain cluster, a private domain pile is', () => {
  const posture = securityPosture(
    dash([
      ...Array.from({ length: 6 }, (_, i) => account(`u${i}@asashi.my.id`)),
      ...Array.from({ length: 6 }, (_, i) => account(`p${i}@gmail.com`)),
    ]),
    NOW,
  );
  assert.deepEqual(posture?.domains.map((c) => c.label), ['asashi.my.id']);
  assert.equal(posture?.domains[0].accounts, 6);
  assert.equal(posture?.attention, 1, 'six on one private domain is worth naming');
});

test('a three person team domain is listed but does not turn the verdict yellow', () => {
  const posture = securityPosture(
    dash([account('a@acme.io'), account('b@acme.io'), account('c@acme.io')]),
    NOW,
  );
  assert.equal(posture?.domains.length, 1, 'the owner still gets to see it');
  assert.equal(posture?.domains[0].open, true);
  assert.equal(posture?.domains[0].wantsLook, false, 'listed, but it does not colour the verdict');
  assert.equal(posture?.attention, 0, 'three colleagues signing up is a normal week');
});

test('signup bursts are bucketed per hour, because the farm was paced per minute', () => {
  // A signup every 40 seconds: three in one hour, never two in one minute.
  const paced = Array.from({ length: 3 }, (_, i) =>
    account(`p${i}@paced.example.org`, { createdAt: Date.parse('2026-09-01T11:00:00Z') + i * 40_000, suspended: i === 0 }),
  );
  const quiet = [account('lonely@quiet.example.org', { createdAt: Date.parse('2026-09-01T09:00:00Z') })];
  const posture = securityPosture(dash([...paced, ...quiet]), NOW);
  assert.deepEqual(posture?.bursts, [{ hour: '2026-09-01T11', signups: 3, suspended: 1 }]);
});

test('signups older than the burst window do not haunt the page', () => {
  const old = Array.from({ length: 4 }, (_, i) =>
    account(`o${i}@old.example.org`, { createdAt: NOW - 30 * 86_400_000 + i * 1_000 }),
  );
  assert.deepEqual(securityPosture(dash(old), NOW)?.bursts, []);
});

test('internal accounts are not the largest farm on the page', () => {
  const posture = securityPosture(
    dash([
      account('bench+one@tiyuvta.ai', { internal: true }),
      account('bench+two@tiyuvta.ai', { internal: true }),
      account('real@acme.io'),
    ]),
    NOW,
  );
  assert.equal(posture?.mailboxes.length, 0, 'owner bench identities share a mailbox on purpose');
  assert.equal(posture?.accounts.external, 1);
});

test('the counters an abuse story needs, including the fence closing late', () => {
  const posture = securityPosture(
    dash(
      [
        account('used@acme.io', { requests: 40, spentMicro: 270_000 }),
        account('late@asashi.my.id', { requests: 12, suspended: true }),
        account('never@asashi.my.id', { requests: 0, suspended: true }),
        account('ageless@acme.io', { createdAt: null }),
      ],
      { accounts: { total: 5, enrolled: 4, suspended: 2, consented: 1, newToday: 3, new7d: 4 } },
    ),
    NOW,
  );
  assert.equal(posture?.accounts.total, 5, 'the console total includes internal accounts');
  assert.equal(posture?.accounts.external, 4);
  assert.equal(posture?.accounts.neverUsed, 2);
  assert.equal(posture?.accounts.suspendedWithTraffic, 1, 'it served traffic before the fence closed');
  assert.equal(posture?.accounts.ageUnknown, 1);
  assert.equal(posture?.accounts.newToday, 3);
  assert.equal(posture?.promo?.remaining, 199);
  assert.equal(posture?.grantedMicro, 20_000_000);
});

test('a suspended account with money behind it stops the verdict reading clear', () => {
  // The header said "clear" through a real suspension, because attention counted
  // clusters only. A suspension the owner did not perform is the shape that took
  // the fleet down for 65 minutes, and the console reports no suspension time, so
  // there is nothing else on the page that could notice one.
  const posture = securityPosture(
    dash([
      account('paid@acme.io', { requests: 400, spentMicro: 2_620_000, paid: true, suspended: true }),
      account('probe@asashi.my.id', { requests: 2, spentMicro: 115, suspended: true }),
      account('spender@other.example', { requests: 90, spentMicro: 270_000, suspended: true }),
    ]),
    NOW,
  );
  assert.equal(posture?.attentionClusters, 0, 'no cluster here is over its bar');
  assert.equal(posture?.attentionSuspensions, 2, 'the buyer and the account that spent real cents');
  assert.equal(posture?.attention, 2, 'so the header cannot say clear');
  assert.equal(posture?.accounts.suspendedWithMoney, 2);
  assert.equal(posture?.accounts.suspendedWithTraffic, 3, 'the looser counter still reports the probe');
});

test('a suspended farm probe does not keep the page permanently yellow', () => {
  // Nine accounts today are suspended with at least one request and every one of
  // them is a sub-cent farm probe, the largest $0.000115. Counting those as
  // attention would leave a verdict that is always yellow, which is a verdict
  // nobody reads, and there is no suspension timestamp to age them out with.
  const posture = securityPosture(
    dash(Array.from({ length: 9 }, (_, i) => account(`p${i}@probe${i}.example`, {
      requests: 2, spentMicro: 115, suspended: true,
    }))),
    NOW,
  );
  assert.equal(posture?.accounts.suspendedWithTraffic, 9);
  assert.equal(posture?.accounts.suspendedWithMoney, 0);
  assert.equal(posture?.attention, 0, 'nothing to do about them, so nothing is claimed');
});

test('no dashboard yet reads as null, not as a page full of confident zeroes', () => {
  assert.equal(securityPosture(undefined), null);
  assert.equal(securityPosture(null), null);
});

test('a malformed email cannot become a cluster label', () => {
  const posture = securityPosture(
    dash([account('not-an-email'), account('also bad@'), account('x@y.z'), account('x+1@y.z')]),
    NOW,
  );
  assert.deepEqual(posture?.mailboxes.map((c) => c.label), ['x@y.z']);
  assert.equal(posture?.accounts.external, 4, 'the row still counts as an account');
});

test('a one-micro enrolment credit is not a grant', () => {
  // The console credits 1 micro-dollar when it enrols an account. Counting any
  // positive balance made the page report 86 grants worth $0.00, which is a
  // sentence that cannot be true.
  const posture = securityPosture(
    dash([
      account('f+a@gmail.com', { creditedMicro: 1 }),
      account('f+b@gmail.com', { creditedMicro: 1 }),
      account('f+c@gmail.com', { creditedMicro: 5_000_001 }),
    ]),
    NOW,
  );
  const cluster = posture?.mailboxes[0];
  assert.equal(cluster?.accounts, 3);
  assert.equal(cluster?.granted, 1, 'only the account that actually took $5');
  assert.equal(cluster?.grantedMicro, 5_000_003, 'the sum still reports every micro it holds');
});

test('a real company on one domain is a customer team, not a farm', () => {
  // nivision.co.il: the owner approved these accounts himself, and at the
  // 3-account domain bar they would otherwise arrive wearing a farm's colour.
  const team = [
    account('ofek@nivision.co.il', { requests: 28, spentMicro: 266_149 }),
    account('dev@nivision.co.il', { requests: 4 }),
    account('ops@nivision.co.il'),
  ];
  const posture = securityPosture(dash(team), NOW);
  assert.ok(posture);
  const cluster = posture.domains.find((d) => d.label === 'nivision.co.il');
  assert.ok(cluster, 'the team still SHOWS: seeing it is useful, flagging it is not');
  assert.equal(cluster.accounts, 3);
  assert.equal(cluster.customer, true, 'one member spent a real cent and nobody is suspended');
  assert.equal(cluster.wantsLook, false, 'so it never reaches the verdict');
  assert.equal(posture.attention, 0, 'the page stays green for a customer');
});

test('a farm cannot buy quiet with one cent through one member', () => {
  const ring = [
    account('paid@asashi.my.id', { requests: 3, spentMicro: 50_000 }),
    ...Array.from({ length: 8 }, (_, i) => account(`n${i}@asashi.my.id`, { suspended: true })),
  ];
  const posture = securityPosture(dash(ring), NOW);
  assert.ok(posture);
  const cluster = posture.domains.find((d) => d.label === 'asashi.my.id');
  assert.ok(cluster);
  assert.equal(cluster.customer, false, 'majority suspended overrides the money test');
  assert.equal(cluster.wantsLook, true);
});
