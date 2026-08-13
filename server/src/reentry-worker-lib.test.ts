import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReentryEvidence } from './reentry.js';
import {
  evidenceHash,
  groundAgentResult,
  parseAgentJson,
  parseOpenCodeOutput,
  pendingEvidenceSources,
} from './reentry-worker-lib.js';

function evidence(): ReentryEvidence {
  return {
    version: 1,
    capturedAt: '2026-08-10T00:00:00.000Z',
    sources: {
      github: { enabled: true, updatedAt: '2026-08-10T00:00:00.000Z', error: null },
      repos: { enabled: true, updatedAt: '2026-08-10T00:00:00.000Z', error: null },
      agents: { enabled: true, updatedAt: '2026-08-10T00:00:00.000Z', error: null },
    },
    constraints: { factsOnly: true, doNotInferAbandonment: true, prioritizePeopleWaiting: true },
    contexts: [
      {
        id: 'one', title: 'Atrium', path: '/home/test/projects/atrium', project: 'atrium', note: 'Ship it',
        energy: 'medium', state: 'parked', createdAt: '2026-08-10T00:00:00.000Z',
        parkedAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z', resumedAt: null,
        git: null, resumeTarget: { kind: 'shell', id: null, capturedAt: '2026-08-10T00:00:00.000Z' },
        capsule: null,
      },
    ],
    repos: [], agentSessions: [], peopleWaiting: [], actNow: [],
  };
}

test('evidence hash ignores scan outputs and capture timestamps', () => {
  const first = evidence();
  const second = evidence();
  second.capturedAt = '2026-08-10T00:15:00.000Z';
  second.sources.github.updatedAt = '2026-08-10T00:15:00.000Z';
  second.contexts[0] = {
    ...second.contexts[0],
    updatedAt: '2026-08-10T00:15:00.000Z',
    capsule: { goal: 'Ship it', verifiedFacts: [], rejectedPaths: [], blocker: null, nextAction: 'Test' },
  };
  assert.equal(evidenceHash(first), evidenceHash(second));
  second.contexts[0].note = 'Changed input';
  assert.notEqual(evidenceHash(first), evidenceHash(second));
});

test('evidence readiness waits only for enabled collectors without a result', () => {
  const input = evidence();
  input.sources.github.updatedAt = null;
  assert.deepEqual(pendingEvidenceSources(input), ['github']);
  input.sources.github.error = 'unavailable';
  assert.deepEqual(pendingEvidenceSources(input), []);
  input.sources.github.error = null;
  input.sources.github.enabled = false;
  assert.deepEqual(pendingEvidenceSources(input), []);
});

test('evidence hash ignores agent heartbeat timestamps but retains status changes', () => {
  const first = evidence();
  first.agentSessions = [{
    provider: 'codex', id: 'session', title: 'work', dir: '/home/test/projects/atrium', model: null,
    status: 'active', updatedAt: '2026-08-10T00:00:00.000Z', live: true,
  }];
  const second = structuredClone(first);
  second.agentSessions[0].updatedAt = '2026-08-10T00:15:00.000Z';
  assert.equal(evidenceHash(first), evidenceHash(second));
  second.agentSessions[0].live = false;
  assert.notEqual(evidenceHash(first), evidenceHash(second));
});

test('OpenCode event parser joins text and retains session ids', () => {
  const output = [
    JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: '{"headline":"Ready",' } }),
    'diagnostic line',
    JSON.stringify({ type: 'text', part: { type: 'text', sessionID: 'ses_1', text: '"summary":"Now","focus":[],"looseEnds":[],"contexts":[]}' } }),
  ].join('\n');
  const parsed = parseOpenCodeOutput(output);
  assert.deepEqual(parsed.sessionIds, ['ses_1']);
  assert.equal(parseAgentJson(parsed.text).headline, 'Ready');
});

test('agent parser rejects prose without the required schema', () => {
  assert.throws(() => parseAgentJson('Everything looks good.'), /no JSON object/);
  assert.throws(() => parseAgentJson('{"headline":"x","summary":"y"}'), /required arrays/);
});

test('grounded result cannot claim a non-empty act-now queue is empty', () => {
  const input = evidence();
  input.actNow = [{ id: 'repo#1', repo: 'repo', title: 'Review this', kind: 'pr', updatedAt: input.capturedAt }];
  const result = groundAgentResult({
    headline: 'Ready to resume',
    summary: 'One parked context remains. No people are waiting and no actNow items exist.',
    focus: [],
    looseEnds: [],
    contexts: [],
  }, input);
  assert.equal(
    result.summary,
    '1 open Re-entry context; 0 people explicitly waiting; 1 act-now item. One parked context remains.',
  );
});
