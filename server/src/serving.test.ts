import test from 'node:test';
import assert from 'node:assert/strict';
import { foldIncidents, incidentFlags, parseEvent } from './collectors/serving.js';

// The collapse-and-clear contract. The serving sentinel's escalation ladder emits the
// SAME condition at 1, 5, 15, 30, 60, 120 ticks and then every 120, so a day of
// continuous failure produces 17 alerts. If those became 17 rows and 17 pages we would
// have rebuilt the alert storm the ladder exists to prevent, so this is the assertion the
// whole lane rests on.

type Event = Parameters<typeof foldIncidents>[0][number];

const NOTICE_TTL = 6 * 3_600_000;
const NOW = Date.parse('2026-08-23T12:00:00Z');

const ev = (over: Partial<Event> = {}): Event => ({
  ts: '2026-08-23T10:00:00Z',
  event: 'raise',
  level: 'critical',
  key: 'stack-a:edge-down',
  title: 'stack-a edge probe failed',
  body: 'https://stack-a.example/health — timeout',
  ...over,
});

test('the whole ladder collapses to ONE incident that escalates and counts', () => {
  const rungs: Event[] = [
    ev({ ts: '2026-08-23T10:00:00Z', level: 'warn', title: 'stack-a edge probe failed' }),
    ev({ ts: '2026-08-23T10:05:00Z', title: 'stack-a STILL DOWN from outside (5m)' }),
    ev({ ts: '2026-08-23T10:15:00Z', title: 'stack-a STILL DOWN from outside (15m)' }),
    ev({ ts: '2026-08-23T11:00:00Z', title: 'stack-a STILL DOWN from outside (1h00m)' }),
  ];
  const [inc, ...rest] = foldIncidents(rungs, NOW, NOTICE_TTL);
  assert.equal(rest.length, 0, 'four alerts must be one incident, not four rows');
  assert.equal(inc.pages, 4);
  assert.equal(inc.open, true);
  // warn first, crit later: the incident escalates under a stable key, which is what
  // makes notify.ts page on the escalation instead of treating it as a new flag
  assert.equal(inc.severity, 'crit');
  assert.equal(inc.firstAt, '2026-08-23T10:00:00Z', 'firstAt is the START of the episode');
  assert.equal(inc.lastAt, '2026-08-23T11:00:00Z');
  assert.match(inc.title, /1h00m/, 'the latest rung is what shows');
  assert.equal(inc.scope, 'stack-a');
  assert.equal(inc.kind, 'edge-down');

  // ...and exactly one flag, whose id is the sentinel's key so it is stable across rungs
  const flags = incidentFlags([inc]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'serving:stack-a:edge-down');
  assert.equal(flags[0].severity, 'crit');
  assert.match(flags[0].detail, /4 alerts since/);
});

test('recovery clears the incident and drops its flag — green after red is information', () => {
  const [inc] = foldIncidents(
    [
      ev({ ts: '2026-08-23T10:00:00Z' }),
      ev({ ts: '2026-08-23T10:05:00Z' }),
      ev({
        ts: '2026-08-23T10:09:00Z',
        event: 'resolve',
        level: 'info',
        title: 'stack-a recovered',
        body: 'edge probe 200 (200 ok) after 5m down',
      }),
    ],
    NOW,
    NOTICE_TTL,
  );
  assert.equal(inc.open, false);
  assert.equal(inc.resolvedAt, '2026-08-23T10:09:00Z');
  assert.match(inc.clearedBy ?? '', /after 5m down/);
  assert.deepEqual(incidentFlags([inc]), [], 'a cleared incident raises no flag');
});

test('a raise after a resolve is a NEW episode, not a continuation', () => {
  const [inc] = foldIncidents(
    [
      ev({ ts: '2026-08-23T08:00:00Z' }),
      ev({ ts: '2026-08-23T08:05:00Z' }),
      ev({ ts: '2026-08-23T08:10:00Z', event: 'resolve', level: 'info', title: 'stack-a recovered' }),
      ev({ ts: '2026-08-23T11:50:00Z', level: 'warn', title: 'stack-a edge probe failed' }),
    ],
    NOW,
    NOTICE_TTL,
  );
  assert.equal(inc.open, true);
  assert.equal(inc.pages, 1, 'the page count is per episode');
  assert.equal(inc.firstAt, '2026-08-23T11:50:00Z', 'not 08:00 — that outage is over');
  assert.equal(inc.severity, 'warn', 'severity does not inherit yesterday’s crit');
});

test('a resolve for a key that never raised is dropped', () => {
  // The sentinel closes BOTH `paused` and `pause-expired` when a pause lifts, without
  // tracking which one it had raised. A tolerant reader is cheaper than making the
  // watchdog remember.
  const out = foldIncidents(
    [ev({ key: 'stack-b:pause-expired', event: 'resolve', level: 'info', title: 'stack-b supervision RESUMED' })],
    NOW,
    NOTICE_TTL,
  );
  assert.deepEqual(out, []);
});

test('capture staleness pages as a crit — the request ledger has no off-box copy', () => {
  const flags = incidentFlags(
    foldIncidents(
      [
        ev({
          key: 'stack-b:capture',
          level: 'critical',
          title: 'stack-b no successful replication cycle',
          body: 'no successful replication cycle in 7447s, for 5m. The newest off-box copy of the request ledger is 7447s old',
        }),
      ],
      NOW,
      NOTICE_TTL,
    ),
  );
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'serving:stack-b:capture');
  assert.equal(flags[0].severity, 'crit');
  assert.match(flags[0].detail, /off-box copy of the request ledger/);
});

test('info-level events are recorded but never flagged', () => {
  const incidents = foldIncidents(
    [
      ev({ key: 'stack-a:version:0.94.0', event: 'notice', level: 'info', title: 'stack-a version changed' }),
      ev({ key: 'stack-a:deploy', event: 'notice', level: 'info', title: 'stack-a deploy in progress' }),
    ],
    NOW,
    NOTICE_TTL,
  );
  assert.equal(incidents.length, 2, 'both are on the record');
  assert.deepEqual(incidentFlags(incidents), [], 'neither interrupts the owner');
});

test('a notice expires on its own clock instead of sitting open forever', () => {
  const milestone = ev({
    key: 'stack-b:restarts-cumulative:50',
    event: 'notice',
    level: 'critical',
    title: 'stack-b 52 cumulative SERVING restarts',
    ts: '2026-08-23T11:30:00Z',
  });
  const fresh = foldIncidents([milestone], NOW, NOTICE_TTL);
  assert.equal(fresh[0].open, true, 'fresh milestone pages');
  assert.equal(incidentFlags(fresh).length, 1);

  const aged = foldIncidents([milestone], Date.parse('2026-08-24T00:00:00Z'), NOTICE_TTL);
  assert.equal(aged[0].open, false, 'past the TTL it closes itself');
  assert.equal(aged[0].clearedBy, 'point-in-time notice, expired');
  assert.deepEqual(incidentFlags(aged), []);

  // and two milestones are two rows, because a milestone crossed twice IS two facts
  const both = foldIncidents(
    [milestone, { ...milestone, key: 'stack-b:restarts-cumulative:75', ts: '2026-08-23T11:45:00Z' }],
    NOW,
    NOTICE_TTL,
  );
  assert.equal(both.length, 2);
  assert.equal(incidentFlags(both).length, 2);
});

test('several stacks red at once stay several incidents, ordered worst-first', () => {
  const incidents = foldIncidents(
    [
      ev({ key: 'stack-a:disk-low', level: 'warn', title: 'stack-a disk low', ts: '2026-08-23T09:00:00Z' }),
      ev({ key: 'stack-b:edge-down', level: 'critical', title: 'stack-b STILL DOWN', ts: '2026-08-23T10:00:00Z' }),
      ev({ key: 'web-site:edge-down', level: 'warn', title: 'web-site website unreachable', ts: '2026-08-23T11:00:00Z' }),
    ],
    NOW,
    NOTICE_TTL,
  );
  assert.deepEqual(
    incidents.map((i) => i.key),
    ['stack-b:edge-down', 'web-site:edge-down', 'stack-a:disk-low'],
    'crit first, then warns newest-first',
  );
  assert.equal(incidentFlags(incidents).length, 3);
});

test('a torn or garbage line costs that line and nothing else', () => {
  // The sentinel appends while this reads, so the last line can be half-written.
  assert.equal(parseEvent('{"ts":"2026-08-23T10:00:00Z","event":"raise","key":"stack-a:edge-'), null);
  assert.equal(parseEvent('not json at all'), null);
  assert.equal(parseEvent('{"ts":"2026-08-23T10:00:00Z"}'), null, 'a keyless event is unusable');
  assert.equal(parseEvent('null'), null);
  assert.equal(parseEvent('[1,2,3]'), null);
  const good = parseEvent(JSON.stringify({ ...ev(), event: 'weird' }));
  assert.equal(good?.event, 'raise', 'an unknown event kind falls back to raise, never silence');
  assert.equal(parseEvent(JSON.stringify(ev()))?.key, 'stack-a:edge-down');
});
