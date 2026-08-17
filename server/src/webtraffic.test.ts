import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelOf,
  channelRowsSql,
  dailyViewsSql,
  foldChannels,
  referrersSql,
  topPathsSql,
  windowClause,
} from './core/webtraffic.js';

// The queries are positional against darklanes shared/analytics/schema.ts —
// these tests pin the column letters so a refactor that touches the SQL strings
// cannot silently start reading the wrong blob.

test('windowClause builds trailing and shifted windows from clamped integers', () => {
  assert.equal(windowClause(7), "timestamp > NOW() - INTERVAL '7' DAY");
  assert.equal(
    windowClause(7, 7),
    "timestamp > NOW() - INTERVAL '14' DAY AND timestamp <= NOW() - INTERVAL '7' DAY",
  );
  // hostile/degenerate inputs never reach the SQL as anything but a positive int
  assert.equal(windowClause(0), "timestamp > NOW() - INTERVAL '1' DAY");
  assert.equal(windowClause(3.9), "timestamp > NOW() - INTERVAL '3' DAY");
  assert.equal(windowClause(7, -2), "timestamp > NOW() - INTERVAL '7' DAY");
});

test('daily views: site is blob1, view events are blob2, day-bucketed', () => {
  const sql = dailyViewsSql('tiyuvta_web', 7);
  assert.match(sql, /toStartOfInterval\(timestamp, INTERVAL '1' DAY\) AS day/);
  assert.match(sql, /blob1 AS site/);
  assert.match(sql, /blob2 = 'view'/);
  assert.match(sql, /FROM tiyuvta_web/);
  assert.match(sql, /ORDER BY day ASC/);
});

test('top paths: path is blob3', () => {
  const sql = topPathsSql('tiyuvta_web', 7, 12);
  assert.match(sql, /blob3 AS path/);
  assert.match(sql, /blob2 = 'view'/);
  assert.match(sql, /LIMIT 12/);
});

test('referrers: kind is blob4, host is blob5, internal journeys excluded', () => {
  const sql = referrersSql('tiyuvta_web', 7, 15);
  assert.match(sql, /blob4 AS kind/);
  assert.match(sql, /blob5 AS host/);
  assert.match(sql, /blob4 != 'internal'/);
});

test('channel rows: campaign is blob10, referrer kind/host ride along', () => {
  const sql = channelRowsSql('tiyuvta_web', 7, 0);
  assert.match(sql, /blob10 AS campaign/);
  assert.match(sql, /blob4 AS kind/);
  assert.match(sql, /blob5 AS host/);
  const previous = channelRowsSql('tiyuvta_web', 7, 7);
  assert.match(previous, /INTERVAL '14' DAY/);
  assert.match(previous, /timestamp <= NOW\(\) - INTERVAL '7' DAY/);
});

test('channelOf: campaign slug wins, with the lab-legacy* and trustedrouter* families', () => {
  // the retired lab pages 301 with these codes (darklanes site/public/_redirects)
  assert.equal(channelOf('lab-legacy', 'direct', ''), 'lab-legacy');
  assert.equal(channelOf('lab-legacy-model', 'internal', ''), 'lab-legacy');
  assert.equal(channelOf('lab-legacy-pricing', 'search', 'google.com'), 'lab-legacy');
  assert.equal(channelOf('trustedrouter', 'direct', ''), 'trustedrouter');
  assert.equal(channelOf('trustedrouter-q38', 'direct', ''), 'trustedrouter');
  // an unknown future code becomes its own channel without a code change
  assert.equal(channelOf('hn-launch', 'aggregator', 'news.ycombinator.com'), 'hn-launch');
});

test('channelOf: without a campaign, the trustedrouter.com listing referrer attributes', () => {
  assert.equal(channelOf('', 'dev', 'trustedrouter.com'), 'trustedrouter');
  assert.equal(channelOf('', 'dev', 'www.trustedrouter.com'), 'trustedrouter');
  assert.equal(channelOf('', 'dev', 'models.trustedrouter.com'), 'trustedrouter');
  // a host merely containing the name is NOT the listing
  assert.equal(channelOf('', 'other', 'nottrustedrouter.com'), 'other');
});

test('channelOf: referrer kind is the fallback; internal navigation is not a channel', () => {
  assert.equal(channelOf('', 'search', 'google.com'), 'search');
  assert.equal(channelOf('', 'direct', ''), 'direct');
  assert.equal(channelOf('', '', ''), 'direct');
  assert.equal(channelOf('', 'internal', ''), null);
});

test('foldChannels aggregates both windows and reports deltas, sorted by views', () => {
  const current = [
    { campaign: 'lab-legacy', kind: 'direct', host: '', views: 3 },
    { campaign: 'lab-legacy-pricing', kind: 'direct', host: '', views: 2 },
    { campaign: '', kind: 'dev', host: 'trustedrouter.com', views: 4 },
    { campaign: '', kind: 'search', host: 'google.com', views: 10 },
    { campaign: '', kind: 'internal', host: '', views: 99 }, // navigation — dropped
  ];
  const previous = [
    { campaign: 'lab-legacy', kind: 'direct', host: '', views: 8 },
    { campaign: '', kind: 'social', host: 'x.com', views: 1 }, // gone this window
  ];
  const stats = foldChannels(current, previous);
  assert.deepEqual(stats, [
    { channel: 'search', views: 10, prevViews: 0, delta: 10 },
    { channel: 'lab-legacy', views: 5, prevViews: 8, delta: -3 },
    { channel: 'trustedrouter', views: 4, prevViews: 0, delta: 4 },
    { channel: 'social', views: 0, prevViews: 1, delta: -1 },
  ]);
});
