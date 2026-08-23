import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flush, init, onFlagsChanged } from './notify.js';
import type { Flag } from '../../shared/types.js';

// The rate limit is the last thing between a real outage and the owner's phone, so it gets
// tested at the seam it actually runs at: init() + onFlagsChanged() + flush() with a real
// sendCmd, not a stubbed internal.
//
// Owner ruling 2026-08-23: crit is exempt from the 5/hr cap that used to apply to everything,
// because on a fleet-wide outage that cap dropped the sixth crit — a second box going down —
// and the alert sources now sit behind their own escalation ladders, so the anti-spam job is
// already done upstream. crit keeps a hard 20/hr ceiling so a runaway writer still cannot
// flood, and warn stays at 5.

const flag = (id: string, severity: Flag['severity']): Flag => ({
  id,
  severity,
  title: `${id} title`,
  detail: `${id} detail`,
  source: 'test',
  raisedAt: '2026-08-23T00:00:00Z',
});

/** A real push backend that records instead of sending. `sh -c script arg` puts arg in $0. */
function recorder(log: string): string[] {
  return ['sh', '-c', `printf '%s\\n' "$0" >> ${JSON.stringify(log)}`];
}

async function dispatched(log: string): Promise<string[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.trim());
}

async function withHarness(
  minSeverity: Flag['severity'],
  body: (log: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-notify-test-'));
  const log = join(dir, 'pages.log');
  try {
    init({
      enabled: true,
      minSeverity,
      throttleMs: 3_600_000,
      notifyClear: true,
      sendCmd: recorder(log),
    });
    await body(log);
  } finally {
    await flush();
    await rm(dir, { recursive: true, force: true });
  }
}

test('six crits in one hour ALL dispatch — the old 5/hr cap dropped the sixth', async () => {
  await withHarness('crit', async (log) => {
    const crits = Array.from({ length: 6 }, (_, i) => flag(`box${i}:edge-down`, 'crit'));
    onFlagsChanged([], crits, []);
    await flush();
    const sent = await dispatched(log);
    assert.equal(sent.length, 6, `expected all 6 crits to reach the phone, got ${sent.length}`);
    // and it is the SIXTH that used to be lost — the second box going down
    assert.ok(
      sent.some((s) => s.includes('box5:edge-down')),
      'the sixth crit is the one the old cap silently dropped',
    );
  });
});

test('the hard ceiling still bites: 25 crits dispatch 20, and the drop is logged', async () => {
  await withHarness('crit', async (log) => {
    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(' '));
    try {
      onFlagsChanged([], Array.from({ length: 25 }, (_, i) => flag(`storm:${i}`, 'crit')), []);
      await flush();
    } finally {
      console.error = realError;
    }
    const sent = await dispatched(log);
    assert.equal(sent.length, 20, `the 20/hr ceiling must hold, got ${sent.length}`);
    // A dropped page that leaves no trace looks exactly like nothing having happened.
    assert.equal(errs.filter((e) => e.includes('DROPPED at the 20/hr ceiling')).length, 5);
  });
});

test('warn stays capped at 5, and warns cannot starve crits', async () => {
  await withHarness('warn', async (log) => {
    // The serving sentinel raises edge-down as a WARN on tick 1 and escalates to crit on tick
    // 5, so a fleet-wide outage produces a burst of warns BEFORE the crits. With one shared
    // budget those warns would eat the crit allowance — which is the whole point of keeping
    // the two counters independent.
    onFlagsChanged([], Array.from({ length: 9 }, (_, i) => flag(`w${i}:disk-low`, 'warn')), []);
    await flush();
    let sent = await dispatched(log);
    assert.equal(sent.length, 5, `warn is unchanged at 5/hr, got ${sent.length}`);

    const warns = Array.from({ length: 9 }, (_, i) => flag(`w${i}:disk-low`, 'warn'));
    const crits = Array.from({ length: 6 }, (_, i) => flag(`c${i}:edge-down`, 'crit'));
    onFlagsChanged(warns, [...warns, ...crits], []);
    await flush();
    sent = await dispatched(log);
    assert.equal(sent.length, 11, `9 exhausted warns + 6 crits should add 6 sends, got ${sent.length - 5}`);
    for (const c of crits) {
      assert.ok(sent.some((s) => s.includes(c.id)), `${c.id} was starved by the warn burst`);
    }
  });
});

test('a crit clear rides the crit ceiling, so every page can be closed', async () => {
  await withHarness('crit', async (log) => {
    // Six crits then six recoveries. Under the old single cap the clears were capped at 5,
    // leaving one page the owner could never close — the exact thing a clear notice is for.
    const crits = Array.from({ length: 6 }, (_, i) => flag(`r${i}:edge-down`, 'crit'));
    onFlagsChanged([], crits, []);
    await flush();
    onFlagsChanged(crits, [], []);
    await flush();
    const sent = await dispatched(log);
    const clears = sent.filter((s) => s.includes('[clear]'));
    assert.equal(clears.length, 6, `all six recoveries must page, got ${clears.length}`);
    for (const c of crits) {
      assert.ok(clears.some((s) => s.includes(c.title)), `${c.id} raised but never cleared`);
    }
  });
});
