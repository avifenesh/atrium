import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiUsageUnconfigured,
  foldModelBoxUsage,
  modelBoxHourlySql,
  modelBoxWindowSql,
  readModelBoxUsage,
} from './core/apiusage.js';

// The queries are positional against the api-router's writeDataPoint order
// (darklanes workers/api-router: blob2=model, blob4=box, double1=ms) — these
// tests pin the column letters so a refactor cannot silently read the wrong
// blob, and pin the pre-blob4 handling so old rows are never attributed to a
// box they were not measured on.

test('window sql: model is blob2, box is blob4, p50 is sample-weighted, empty boxes kept for the fold', () => {
  const sql = modelBoxWindowSql(24);
  assert.match(sql, /blob2 AS model/);
  assert.match(sql, /blob4 AS box/);
  assert.match(sql, /quantileWeighted\(0\.5\)\(double1, _sample_interval\)/);
  assert.match(sql, /FROM tiyuvta_api/);
  assert.match(sql, /INTERVAL '24' HOUR/);
  assert.match(sql, /blob2 != ''/);
  // blob4='' rows MUST reach the fold — they are the pre-blob4 count.
  assert.doesNotMatch(sql, /blob4 != ''/);
  // degenerate windows never reach the SQL as anything but a positive int
  assert.match(modelBoxWindowSql(0.5), /INTERVAL '1' HOUR/);
});

test('hourly sql: hour-bucketed, oldest first, unattributable rows excluded', () => {
  const sql = modelBoxHourlySql();
  assert.match(sql, /toStartOfInterval\(timestamp, INTERVAL '1' HOUR\) AS hour/);
  assert.match(sql, /blob4 != ''/);
  assert.match(sql, /ORDER BY hour ASC/);
});

test('fold: pre-blob4 rows are counted apart, never attributed; strings coerce; 1h joins onto 24h', () => {
  const rows24 = [
    // AE answers UInt64 aggregates as strings — the real API shape.
    { model: 'qwen/qwen3.8-27b', box: '', n: '552', p50: 1236 },
    { model: 'ornith-ai/ornith-1.5-35b-a3b', box: '', n: '286', p50: 559 },
    { model: 'qwen/qwen3.8-27b', box: 'de', n: '40', p50: 431.7 },
    { model: 'qwen/qwen3.8-27b', box: 'nj', n: '90', p50: 388 },
    { model: 'ornith-ai/ornith-1.5-35b-a3b', box: 'ornith-api.tiyuvta.ai', n: '12', p50: 502 },
  ];
  const rows1 = [
    { model: 'qwen/qwen3.8-27b', box: 'nj', n: '9', p50: 401 },
    // A model+box pair with 1h traffic but (theoretically) no 24h row still shows.
    { model: 'ornith-ai/ornith-1.5-35b-a3b', box: 'de', n: '2', p50: 610 },
    { model: 'qwen/qwen3.8-27b', box: '', n: '3', p50: 900 },
  ];
  const hourly = [
    { hour: '2026-08-23 16:00:00', model: 'qwen/qwen3.8-27b', box: 'de', n: '40', p50: 431.7 },
    { hour: '2026-08-23 17:00:00', model: 'qwen/qwen3.8-27b', box: 'nj', n: '90', p50: 388 },
  ];

  const usage = foldModelBoxUsage(rows24, rows1, hourly);

  // Old rows are a count, not a box.
  assert.equal(usage.preBlob4Requests24h, 838);
  assert.equal(usage.windows.some((row) => row.box === ''), false);

  // Busiest first; the 1h cut joined onto its (model, box).
  assert.deepEqual(usage.windows[0], {
    model: 'qwen/qwen3.8-27b',
    box: 'nj',
    requests1h: 9,
    requests24h: 90,
    p50Ms1h: 401,
    p50Ms24h: 388,
  });
  const de = usage.windows.find((row) => row.box === 'de' && row.model === 'qwen/qwen3.8-27b');
  assert.deepEqual(de, { model: 'qwen/qwen3.8-27b', box: 'de', requests1h: 0, requests24h: 40, p50Ms1h: null, p50Ms24h: 432 });
  const ornDe = usage.windows.find((row) => row.box === 'de' && row.model.startsWith('ornith'));
  assert.deepEqual(ornDe, {
    model: 'ornith-ai/ornith-1.5-35b-a3b',
    box: 'de',
    requests1h: 2,
    requests24h: 0,
    p50Ms1h: 610,
    p50Ms24h: null,
  });

  // Hour buckets normalise the AE DateTime and stay chronological.
  assert.deepEqual(usage.hours.map((row) => row.hour), ['2026-08-23T16:00:00', '2026-08-23T17:00:00']);
  assert.equal(usage.hours[1].p50Ms, 388);
});

test('fold: empty inputs produce an empty report, not a crash', () => {
  assert.deepEqual(foldModelBoxUsage([], [], []), { windows: [], hours: [], preBlob4Requests24h: 0 });
});

test('read: a missing credentials file is Unconfigured, not a fetch', async () => {
  const home = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'apiusage-nocreds-'));
  process.env.HOME = dir;
  const fetchBefore = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response('{}');
  }) as typeof fetch;
  try {
    await assert.rejects(readModelBoxUsage(), ApiUsageUnconfigured);
    assert.equal(fetched, false);
  } finally {
    process.env.HOME = home;
    globalThis.fetch = fetchBefore;
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read: an AE error surfaces with its status instead of folding garbage', async () => {
  const home = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'apiusage-creds-'));
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync(join(dir, '.config/tiyuvta'), { recursive: true });
  writeFileSync(join(dir, '.config/tiyuvta/cloudflare.env'), 'CLOUDFLARE_ACCOUNT_ID=acc\nCLOUDFLARE_API_TOKEN=tok\n');
  process.env.HOME = dir;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => new Response('denied', { status: 403 })) as typeof fetch;
  try {
    await assert.rejects(readModelBoxUsage(), /AE SQL 403/);
  } finally {
    process.env.HOME = home;
    globalThis.fetch = fetchBefore;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read: happy path issues the three queries and folds them', async () => {
  const home = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'apiusage-happy-'));
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync(join(dir, '.config/tiyuvta'), { recursive: true });
  writeFileSync(join(dir, '.config/tiyuvta/cloudflare.env'), 'CLOUDFLARE_ACCOUNT_ID=acc\nCLOUDFLARE_API_TOKEN=tok\n');
  process.env.HOME = dir;
  const fetchBefore = globalThis.fetch;
  const sqls: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const sql = String(init?.body ?? '');
    sqls.push(sql);
    const row = sql.includes('toStartOfInterval')
      ? { hour: '2026-08-23 16:00:00', model: 'm', box: 'de', n: '5', p50: 100 }
      : { model: 'm', box: 'de', n: sql.includes("'1' HOUR") ? '2' : '5', p50: 100 };
    return new Response(JSON.stringify({ data: [row] }), { status: 200 });
  }) as typeof fetch;
  try {
    const usage = await readModelBoxUsage();
    assert.equal(sqls.length, 3);
    assert.deepEqual(usage.windows, [
      { model: 'm', box: 'de', requests1h: 2, requests24h: 5, p50Ms1h: 100, p50Ms24h: 100 },
    ]);
    assert.equal(usage.hours.length, 1);
    assert.equal(usage.preBlob4Requests24h, 0);
  } finally {
    process.env.HOME = home;
    globalThis.fetch = fetchBefore;
    rmSync(dir, { recursive: true, force: true });
  }
});
