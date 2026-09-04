// The traffic-shape collector must (1) read darklanes' summary into the extra lane with the
// customer rows on top, (2) call a stale rollup stale instead of showing old numbers as
// current, (3) say "not on this machine" rather than failing when there is no archive, and
// (4) report unreadable JSON as an error. A panel that shows a stale number as current is
// the failure this file exists to prevent.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { config } from './config.js';
import { store } from './state.js';

const SUMMARY = {
  updatedAt: '2026-09-04T10:00:00Z',
  windows: ['24h', '7d', '30d', 'all'],
  archive: { requests: 90828, from: '2026-08-15', to: '2026-09-04' },
  models: [
    {
      model: 'qwen/qwen3.8-27b',
      cls: 'customer',
      windows: {
        '24h': { requests: 2, served: 2, prompt: 100, cached: 0, completion: 120, inOut: 0.8, cachedShare: 0, promptP50: 59, promptP90: 73, completionP50: 28, completionP90: 256 },
        '7d': { requests: 317, served: 306, prompt: 24_000_000, cached: 18_800_000, completion: 533_000, inOut: 45, cachedShare: 0.784, promptP50: 80_213, promptP90: 125_901, completionP50: 301, completionP90: 3502 },
      },
    },
    {
      model: 'qwen/qwen3.8-27b',
      cls: 'internal',
      windows: { '7d': { requests: 2904, served: 2904, prompt: 153_000, cached: 44_000, completion: 15_000, inOut: 9.9, cachedShare: 0.29, promptP50: 53, promptP90: 53, completionP50: 1, completionP90: 1 } },
    },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'usagemix-'));
const original = config.serving.stateDir;
config.serving.stateDir = dir;
after(() => {
  config.serving.stateDir = original;
});

const load = async () => (await import('./collectors/usagemix.js')).default;
const section = () => store.get().extra['usagemix'];

describe('usagemix collector', () => {
  it('says so when there is no archive on this machine, and does not fail', async () => {
    const c = await load();
    await c.run();
    const s = section();
    assert.equal(s.up, true);
    assert.equal(s.data, null);
    assert.match(s.rows?.[0].value ?? '', /not on this machine/);
  });

  it('ingests the summary: archive line, customer rows first, no tenant ids', async () => {
    writeFileSync(join(dir, 'usage-summary.json'), JSON.stringify(SUMMARY));
    const c = await load();
    await c.run();
    const s = section();
    assert.equal(s.up, true);
    const data = s.data as typeof SUMMARY & { staleHours: number | null };
    assert.equal(data.staleHours, null);
    assert.equal(data.models.length, 2);
    assert.equal(data.archive?.requests, 90828);
    const rows = s.rows ?? [];
    assert.match(rows[0].value, /90,828 requests/);
    // one row per model a customer used, and the internal row is not among them
    const modelRows = rows.filter((r) => r.label === 'qwen3.8-27b');
    assert.equal(modelRows.length, 1);
    assert.match(modelRows[0].value, /306 req · 45:1 in:out · 78% cached/);
    assert.doesNotMatch(JSON.stringify(s), /ten_/);
  });

  it('calls a stale rollup stale instead of showing its numbers as current', async () => {
    const path = join(dir, 'usage-summary.json');
    writeFileSync(path, JSON.stringify(SUMMARY));
    const old = new Date(Date.now() - 30 * 3_600_000);
    utimesSync(path, old, old);
    const c = await load();
    await c.run();
    const s = section();
    assert.equal(s.up, false, 'a 30h-old rollup is not up');
    assert.equal((s.data as { staleHours: number | null }).staleHours, 30);
    assert.ok((s.rows ?? []).some((r) => r.tone === 'err' && /timer has stopped/.test(r.value)));
  });

  it('reports unreadable JSON as an error rather than an empty panel', async () => {
    writeFileSync(join(dir, 'usage-summary.json'), '{ not json');
    const c = await load();
    await c.run();
    const s = section();
    assert.equal(s.up, false);
    assert.match(s.error ?? '', /not readable JSON/);
  });
});
