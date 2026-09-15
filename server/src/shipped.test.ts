import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, dayStart, localDate, parseGitLog, parsePrRows } from './shipped.js';
import type { ShippedCommit } from '../../shared/types.js';

// The day-boundary and fold contract for the shipped board. Dates are built with the
// local constructor so the assertions hold in any zone the daemon runs in.

test('dayStart rolls at the configured hour, so a 01:30 commit stays with its evening', () => {
  const late = new Date(2026, 8, 15, 1, 30); // Sep 15 01:30 local
  assert.deepEqual(dayStart(late, 4), new Date(2026, 8, 14, 4, 0));
  const morning = new Date(2026, 8, 15, 9, 0);
  assert.deepEqual(dayStart(morning, 4), new Date(2026, 8, 15, 4, 0));
  assert.deepEqual(dayStart(late, 0), new Date(2026, 8, 15, 0, 0));
  // exactly on the boundary counts as the new day
  assert.deepEqual(dayStart(new Date(2026, 8, 15, 4, 0), 4), new Date(2026, 8, 15, 4, 0));
  // garbage config degrades to midnight instead of throwing
  assert.deepEqual(dayStart(morning, Number.NaN), new Date(2026, 8, 15, 0, 0));
  assert.equal(localDate(new Date(2026, 0, 3)), '2026-01-03');
});

test('parseGitLog reads the record-separated format and tolerates missing stat lines', () => {
  const raw = [
    '\x1eaaa111\x1f2026-09-15T10:00:00+03:00\x1ffix: the thing; with "quotes" and | pipes\n',
    '\n 3 files changed, 40 insertions(+), 7 deletions(-)\n',
    '\x1ebbb222\x1f2026-09-15T11:00:00+03:00\x1frename only\n',
    '\n 1 file changed, 0 insertions(+), 0 deletions(-)\n',
    '\x1eccc333\x1f2026-09-15T12:00:00+03:00\x1fempty commit\n',
  ].join('');
  const commits = parseGitLog(raw, 'atrium', 'avifenesh/atrium');
  assert.equal(commits.length, 3);
  assert.deepEqual(commits[0], {
    sha: 'aaa111', repo: 'atrium', origin: 'avifenesh/atrium', at: '2026-09-15T10:00:00+03:00',
    subject: 'fix: the thing; with "quotes" and | pipes', add: 40, del: 7,
  });
  assert.equal(commits[1].add, 0);
  assert.equal(commits[2].subject, 'empty commit');
  assert.equal(commits[2].del, 0);
  assert.deepEqual(parseGitLog('', 'x', null), []);
});

test('parsePrRows stamps merged rows with closedAt, open rows with createdAt, and trims by since', () => {
  const since = new Date(2026, 8, 15, 4, 0);
  const before = new Date(2026, 8, 15, 2, 0).toISOString();
  const after = new Date(2026, 8, 15, 9, 0).toISOString();
  const raw = JSON.stringify([
    { number: 1, title: 'old', url: 'https://github.com/o/r/pull/1', repository: { nameWithOwner: 'o/r' }, closedAt: before, createdAt: before },
    { number: 2, title: 'new', url: 'https://github.com/o/r/pull/2', repository: { nameWithOwner: 'o/r' }, closedAt: after, createdAt: before },
    { number: 3, title: 'no repo field', url: 'https://github.com/o/z/pull/3', closedAt: after, createdAt: after },
  ]);
  const merged = parsePrRows(raw, 'merged', since);
  assert.deepEqual(merged.map((p) => [p.number, p.repo, p.at]), [[2, 'o/r', after], [3, 'o/z', after]]);
  // as "opened" rows, #2 was created before the day started and drops out
  assert.deepEqual(parsePrRows(raw, 'open', since).map((p) => p.number), [3]);
  assert.deepEqual(parsePrRows('not json', 'open', since), []);
  assert.deepEqual(parsePrRows('{"a":1}', 'open', since), []);
});

const c = (over: Partial<ShippedCommit>): ShippedCommit => ({
  sha: 'x', repo: 'r', origin: null, at: '2026-09-15T10:00:00.000Z', subject: 's', add: 1, del: 1, ...over,
});

test('buildReport dedupes by sha, buckets by hour from since, and lets merged beat open', () => {
  const since = new Date('2026-09-15T04:00:00.000Z');
  const report = buildReport({
    since,
    dayStartHour: 4,
    authors: ['me'],
    commits: [
      c({ sha: 'a', repo: 'alpha', at: '2026-09-15T04:10:00.000Z', add: 10, del: 2 }),
      c({ sha: 'a', repo: 'wt-alpha', at: '2026-09-15T04:10:00.000Z', add: 10, del: 2 }), // same commit, second path
      c({ sha: 'b', repo: 'beta', at: '2026-09-15T13:59:00.000Z', add: 5, del: 0 }),
      c({ sha: 'c', repo: 'beta', at: '2026-09-15T13:01:00.000Z', add: 0, del: 3 }),
      c({ sha: 'd', repo: 'gamma', at: '2026-09-16T05:00:00.000Z' }), // past the 24h window: counted, not bucketed
    ],
    prs: [
      { repo: 'o/r', number: 7, title: 't', url: 'u7', state: 'open', at: '2026-09-15T08:00:00.000Z' },
      { repo: 'o/r', number: 7, title: 't', url: 'u7', state: 'merged', at: '2026-09-15T12:00:00.000Z' },
      { repo: 'o/r', number: 8, title: 't', url: 'u8', state: 'open', at: '2026-09-15T13:00:00.000Z' },
    ],
    prsError: null,
  });
  assert.deepEqual(report.commits.map((x) => x.sha), ['d', 'b', 'c', 'a']);
  assert.equal(report.byHour[0], 1); // 04:10 lands in the first bucket
  assert.equal(report.byHour[9], 2); // 13:01 and 13:59 share the 13:00 bucket
  assert.equal(report.byHour.reduce((s, n) => s + n, 0), 3);
  assert.deepEqual(report.byRepo.map((r) => [r.repo, r.commits, r.add, r.del]), [['beta', 2, 5, 3], ['alpha', 1, 10, 2], ['gamma', 1, 1, 1]]);
  assert.deepEqual(report.prs.map((p) => [p.number, p.state]), [[8, 'open'], [7, 'merged']]);
  assert.deepEqual(report.totals, { commits: 4, repos: 3, add: 16, del: 6, prsMerged: 1, prsOpened: 1 });
  assert.equal(report.since, since.toISOString());
  assert.equal(report.prsCapped, false);
});
