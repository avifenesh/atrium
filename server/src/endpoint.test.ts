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
  failures: 1,
  dominantFault: null,
  lastFaultDetail: null,
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

// DEGRADED IS ITS OWN CONDITION (2026-09-04).
//
// glm-5.3-flash failed 44 of 313 probes across two days — one request in seven — and the
// panel's only vocabulary was DOWN, which fired for five minutes when a failure happened
// to land last and cleared on the next probe. The owner asked what was wrong three times;
// the honest answer, "it is up and losing 14% of requests", was not a thing the code could
// say. These arms are that sentence.

test('a model answering NOW with a bad 24h record raises a degraded warn, not a crit', () => {
  const flags = downFlags([
    model({ ok: true, uptimePct: 85.9, failures: 44, probes: 313, dominantFault: 'http x30',
            lastFaultDetail: 'the origin did not answer response headers within the deadline' }),
  ]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'endpoint:degraded:qwen/qwen3.8-27b');
  assert.equal(flags[0].severity, 'warn');
  assert.match(flags[0].title, /DEGRADED/);
  assert.match(flags[0].title, /14\.1%/);              // says the number, not just the word
  assert.match(flags[0].detail, /44 of 313/);
  assert.match(flags[0].detail, /http x30/);            // and WHY
  assert.match(flags[0].detail, /deadline/);
  assert.match(flags[0].detail, /up right now/);        // so nobody chases a dead box
});

test('a healthy model is not degraded, and a young window is not judged', () => {
  assert.deepEqual(downFlags([model({ uptimePct: 99.5, probes: 288 })]), []);
  // 97% is the line; 97.0 is not below it.
  assert.deepEqual(downFlags([model({ uptimePct: 97, probes: 288 })]), []);
  // Too few probes to judge: after a restart the window is tiny and one failure is 50%.
  assert.deepEqual(downFlags([model({ uptimePct: 50, probes: 2, failures: 1 })]), []);
});

test('DOWN wins over degraded for the same model, and carries the reason', () => {
  const flags = downFlags([
    model({ ok: false, uptimePct: 85.9, failures: 44, probes: 313,
            dominantFault: 'timeout x12', lastFaultDetail: 'TimeoutError: signal timed out' }),
  ]);
  // One flag, not two: a model that is down must not also page as degraded.
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'crit');
  assert.match(flags[0].detail, /timeout x12/);
  assert.match(flags[0].detail, /signal timed out/);
});

test('a credential rejection is still neither down nor degraded', () => {
  const blocked = [model({ ok: false, authFault: true, uptimePct: 40, failures: 100, probes: 200 })];
  const flags = downFlags(blocked);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'endpoint:probe-credential');
  assert.equal(flags[0].severity, 'warn');
});
