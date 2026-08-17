import test from 'node:test';
import assert from 'node:assert/strict';
import type { HelperEvidence } from './helper.js';
import { buildHelperLaunchScript } from './helper.js';
import {
  claudeSessionFileId,
  codexSessionFileId,
  parseClaudeSessionLines,
  parseCodexSessionLines,
  parseGrokSessionLines,
} from './helper-sessions.js';
import {
  helperEvidenceHash,
  hasIndependentOfferEvidence,
  normalizeHelperInterval,
  offerFingerprint,
  parseClaudeStructuredOutput,
  parseHelperAgentOutput,
  systemdInterval,
} from './helper-worker-lib.js';

function evidence(): HelperEvidence {
  return {
    version: 1,
    capturedAt: '2026-08-15T00:00:00.000Z',
    constraints: { readOnlyScout: true, noOfferQuota: true, exactExecutorPromptRequired: true },
    sources: [{
      id: 'workspace',
      label: 'Workspace',
      status: 'ready',
      detail: 'one repo',
      itemCount: 1,
      updatedAt: '2026-08-15T00:00:00.000Z',
    }],
    offerHistory: [],
    preferences: [],
    skills: [],
    pendingFeedback: [],
    repositories: [{
      name: 'atrium',
      path: '/home/test/projects/atrium',
      branch: 'main',
      dirty: 1,
      ahead: 0,
      behind: 0,
      lastCommitAt: '2026-08-15T00:00:00.000Z',
    }],
    github: { repositories: [], actNow: [], peopleWaiting: [], pullRequests: [], mentions: [], notifications: [] },
    gmail: [],
    linkedin: { mail: [], exports: [] },
    sessions: [],
    reentry: [],
    recentNotes: [],
  };
}

test('helper evidence hash ignores scan clocks but retains observed changes', () => {
  const first = evidence();
  const second = structuredClone(first);
  second.capturedAt = '2026-08-15T03:00:00.000Z';
  second.sources[0].updatedAt = second.capturedAt;
  assert.equal(helperEvidenceHash(first), helperEvidenceHash(second));
  second.sessions = [{
    provider: 'codex',
    id: 'one',
    path: '/home/test/projects/atrium',
    title: 'Fix Atrium',
    updatedAt: second.capturedAt,
    messageCount: 2,
    contentHash: 'a'.repeat(64),
    excerpt: [{ role: 'user', text: 'Fix Atrium' }],
  }];
  first.sessions = [{ ...second.sessions[0], updatedAt: first.capturedAt }];
  assert.equal(helperEvidenceHash(first), helperEvidenceHash(second));
  second.sessions[0].contentHash = 'b'.repeat(64);
  assert.notEqual(helperEvidenceHash(first), helperEvidenceHash(second));
  first.sessions = [];
  second.sessions = [];
  second.repositories[0].dirty = 2;
  assert.notEqual(helperEvidenceHash(first), helperEvidenceHash(second));
});

test('Claude Code structured output wrappers and plain fixtures parse', () => {
  const result = { scanSummary: 'quiet', offers: [], preferenceUpdates: [], skillUpdates: [] };
  assert.deepEqual(parseHelperAgentOutput(JSON.stringify(result)), result);
  assert.deepEqual(parseHelperAgentOutput(JSON.stringify({ structured_output: result })), result);
  assert.deepEqual(parseHelperAgentOutput(JSON.stringify({ result: JSON.stringify(result) })), result);
  assert.throws(() => parseHelperAgentOutput('No work today.'), /no JSON object/);
  const digests = { digests: [{ provider: 'codex', id: 'one', status: 'open', summary: 'Unfinished task.' }] };
  assert.deepEqual(parseClaudeStructuredOutput(JSON.stringify({ structuredOutput: digests })), digests);
});

test('helper cadence is bounded from ten minutes to one week', () => {
  assert.equal(normalizeHelperInterval(600_001), 600_000);
  assert.equal(systemdInterval(3 * 60 * 60_000), '10800s');
  assert.throws(() => normalizeHelperInterval(9 * 60_000), /between 10 minutes and 1 week/);
  assert.throws(() => normalizeHelperInterval(8 * 24 * 60 * 60_000), /between 10 minutes and 1 week/);
});

test('offer fingerprints are stable across evidence ordering', () => {
  const first = {
    key: 'fix-atrium',
    path: '/home/test/projects/atrium',
    evidence: [
      { source: 'github', id: 'repo#1', detail: 'failed' },
      { source: 'workspace', id: 'atrium', detail: 'dirty' },
    ],
  };
  const second = { ...first, evidence: [...first.evidence].reverse() };
  assert.equal(offerFingerprint(first), offerFingerprint(second));
  second.evidence[0] = { ...second.evidence[0], detail: 'clean' };
  assert.notEqual(offerFingerprint(first), offerFingerprint(second));
});

test('workspace metadata cannot stand alone as offer evidence', () => {
  assert.equal(hasIndependentOfferEvidence([{ source: 'workspace' }, { source: 'workspace' }]), false);
  assert.equal(hasIndependentOfferEvidence([{ source: 'workspace' }, { source: 'github' }]), true);
});

test('Kitty launch scripts read the exact private prompt and quote paths', () => {
  const claude = buildHelperLaunchScript(
    'claude',
    '/home/test/bin/claude',
    "/home/test/projects/owner's repo",
    "/home/test/.config/offer's prompt.md",
  );
  assert.match(claude, /--model opus "\$prompt"/);
  assert.match(claude, /prompt="\$\(cat '\/home\/test\/\.config\/offer'\\''s prompt\.md'\)"/);
  assert.match(claude, /cd '\/home\/test\/projects\/owner'\\''s repo'/);
  const codex = buildHelperLaunchScript('codex', '/home/test/bin/codex', '/home/test/projects/repo', '/tmp/prompt.md');
  assert.match(codex, /--search -C '\/home\/test\/projects\/repo' "\$prompt"/);
});

test('session parsers retain only user and assistant text, never tool traces', () => {
  const claude = parseClaudeSessionLines([
    JSON.stringify({
      type: 'user',
      timestamp: '2026-08-14T10:00:00.000Z',
      sessionId: 'claude-one',
      cwd: '/home/avifenesh/projects/atrium',
      message: { role: 'user', content: 'Fix the timer' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-14T11:00:00.000Z',
      sessionId: 'claude-one',
      cwd: '/home/avifenesh/projects/atrium',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'I will inspect it.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { token: 'secret' } }] },
    }),
  ], 'fallback', '2026-08-15T00:00:00.000Z');
  assert.equal(claude?.id, 'claude-one');
  assert.equal(claude?.updatedAt, '2026-08-14T11:00:00.000Z');
  assert.deepEqual(claude?.excerpt.map((message) => message.text), ['Fix the timer', 'I will inspect it.']);

  const codex = parseCodexSessionLines([
    JSON.stringify({ timestamp: '2026-08-14T09:00:00.000Z', type: 'session_meta', payload: { id: 'codex-one', cwd: '/home/avifenesh/projects/atrium' } }),
    JSON.stringify({
      timestamp: '2026-08-14T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ship it' }] },
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'secret tool output' } }),
    JSON.stringify({
      timestamp: '2026-08-14T12:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] },
    }),
  ], 'fallback', '2026-08-15T00:00:00.000Z');
  assert.equal(codex?.id, 'codex-one');
  assert.equal(codex?.updatedAt, '2026-08-14T12:00:00.000Z');
  assert.deepEqual(codex?.excerpt.map((message) => message.text), ['Ship it', 'Tests pass.']);

  const grok = parseGrokSessionLines([
    JSON.stringify({ type: 'system', content: 'private system prompt' }),
    JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: '<system-reminder>tool catalog</system-reminder><user_query>Audit agent-sh</user_query>' }],
    }),
    JSON.stringify({ type: 'reasoning', summary: 'private reasoning' }),
    JSON.stringify({ type: 'assistant', content: 'The audit is complete.', tool_calls: [{ name: 'shell' }] }),
  ], 'grok-one', '/home/avifenesh/projects/agent-sh/agnix', '2026-08-15T00:00:00.000Z');
  assert.equal(grok?.id, 'grok-one');
  assert.deepEqual(grok?.excerpt.map((message) => message.text), ['Audit agent-sh', 'The audit is complete.']);
  assert.equal(grok?.messageCount, 2);
  assert.equal(grok?.contentHash.length, 64);
});

test('session file identities separate Claude children and Codex rollout copies', () => {
  assert.equal(
    claudeSessionFileId(
      '/home/test/.claude/projects/repo/parent/subagents/agent-child.jsonl',
      'parent',
    ),
    'parent/subagent/agent-child',
  );
  assert.equal(
    claudeSessionFileId('/home/test/.claude/projects/repo/parent.jsonl', 'parent'),
    'parent',
  );
  assert.equal(
    codexSessionFileId('/home/test/.codex/sessions/rollout-2026-08-15T00-00-00-01a001c7-bd07-7b42-b2ca-a175fe4fe23c.jsonl'),
    '01a001c7-bd07-7b42-b2ca-a175fe4fe23c',
  );
});
