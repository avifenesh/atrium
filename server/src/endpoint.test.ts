import test from 'node:test';
import assert from 'node:assert/strict';
import { downFlags } from './collectors/endpoint.js';

// The down-flag is the phone pager: a model whose last probe failed (twice in a
// row — run() retries in-run) must raise exactly one crit flag with a stable id,
// and a healthy model must raise none, or every recovery notice breaks.

const model = (over: Record<string, unknown> = {}) => ({
  model: 'qwen/qwen3.8-27b',
  ok: true,
  ttftMs: 300,
  checkedAt: '2026-08-20T06:00:00.000Z',
  uptimePct: 99.5,
  p50TtftMs: 310,
  probes: 288,
  ...over,
}) as Parameters<typeof downFlags>[0][number];

test('endpoint down → one crit flag with a stable id; healthy → none', () => {
  assert.deepEqual(downFlags([model()]), []);

  const flags = downFlags([model({ ok: false, ttftMs: null }), model({ model: 'google/gemma-4-31b-it' })]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'endpoint:down:qwen/qwen3.8-27b');
  assert.equal(flags[0].severity, 'crit');
  assert.match(flags[0].title, /not answering/);
  assert.match(flags[0].detail, /twice in a row/);
});
