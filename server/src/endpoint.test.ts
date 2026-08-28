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
  authFault: false,
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

// 2026-08-28: memra v0.117 made unenrolled tenants fail closed. The probe key's
// tenant lost its free pass and every model rendered DOWN for ~10h while customers
// were served the whole time. A rejected credential is ONE fault about one key —
// never N crit pages about N models, and never evidence the endpoint is down.
test('every model rejected on credentials → one warn about the key, no down pages', () => {
  const blocked = [
    model({ ok: false, ttftMs: null, authFault: true }),
    model({ model: 'ornith-ai/ornith-1.5-35b-a3b', ok: false, ttftMs: null, authFault: true }),
  ];
  const flags = downFlags(blocked);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'endpoint:probe-credential');
  assert.equal(flags[0].severity, 'warn');
  assert.match(flags[0].title, /UNKNOWN, not down/);
  assert.equal(
    flags.some((f) => f.id.startsWith('endpoint:down:')),
    false,
    'a dead probe key must never page as a model outage',
  );
});

// The credential path must not swallow a real outage that happens beside it: if
// one model answers and another is genuinely dead, that is still a crit page.
test('a real outage alongside a credential fault still pages crit', () => {
  const flags = downFlags([
    model({ ok: false, ttftMs: null, authFault: true }),
    model({ model: 'ornith-ai/ornith-1.5-35b-a3b', ok: false, ttftMs: null }),
  ]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'endpoint:down:ornith-ai/ornith-1.5-35b-a3b');
  assert.equal(flags[0].severity, 'crit');
});
