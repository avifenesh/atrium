import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFromFirstAction, actionFromOutreachNotes, asDoLabel, buildDoPrompt, isPlaceholderAction, launchScript, liveRosterFromFacts, parseAction } from './crm-do.js';
import type { CrmItem } from '../../shared/types.js';

const item: CrmItem = {
  id: 's-1',
  kind: 'lead',
  title: 'Who hosts Qwen cheap',
  subtitle: null,
  source: 'hn',
  detail: 'looking for an API',
  url: 'https://example.com/1',
  action: { label: 'do draft a reply', brief: 'Open on their host question.', href: 'https://example.com/1', updatedAt: '2026-08-29T00:00:00Z' },
  stage: 'new',
  derivedStage: 'new',
  overridden: false,
  followUpAt: null,
  followUpDue: false,
  notes: [],
  contacts: [],
  metrics: null,
  activityAt: '2026-08-29T00:00:00Z',
  relevance: null,
};

test('parseAction: empty or unlabeled is null; label is trimmed and capped', () => {
  assert.equal(parseAction(null), null);
  assert.equal(parseAction({ brief: 'nope' }), null);
  assert.equal(parseAction({ label: '   ' }), null);
  const action = parseAction({ label: '  do reply on the thread  ', brief: 'Open on their invoice.', href: 'https://x.com/a' }, '2026-08-29T00:00:00Z');
  assert.deepEqual(action, {
    label: 'do reply on the thread',
    brief: 'Open on their invoice.',
    href: 'https://x.com/a',
    updatedAt: '2026-08-29T00:00:00Z',
  });
});

test('actionFromFirstAction uses the first sentence as the card label', () => {
  const action = actionFromFirstAction(
    'Draft a mail to the maintainer. Then file the docs PR.',
    'https://example.com/x',
    '2026-08-20T00:00:00Z',
  );
  assert.equal(action?.label, 'Draft a mail to the maintainer');
  assert.match(action?.brief ?? '', /docs PR/);
  assert.equal(action?.href, 'https://example.com/x');
  assert.equal(actionFromFirstAction('   ', null, '2026-08-20T00:00:00Z'), null);
});

test('asDoLabel prefixes do unless the line already starts with a verb', () => {
  assert.equal(asDoLabel('join the server'), 'do join the server');
  assert.equal(asDoLabel('do draft a mail'), 'do draft a mail');
  assert.equal(asDoLabel('Draft a reply on X'), 'Draft a reply on X');
});

test('isPlaceholderAction reads the template BRIEF, never the label', () => {
  assert.equal(isPlaceholderAction(null), true);
  // The two markers the seller hunt's templates carry (crm-stick-action.py).
  assert.equal(isPlaceholderAction({
    label: 'do draft a reply to agents — I need credits',
    brief: 'I need credits\nQualify against companies/heavy-users and always-on agents. Draft only — Avi sends.',
    href: 'https://x.com/a',
    updatedAt: '2026-08-29T00:00:00Z',
  }), true);
  assert.equal(isPlaceholderAction({
    label: 'do qualify and draft a reply — t-1',
    brief: 'Read the thread. Do not invent prices; the do-prompt injects live facts.',
    href: null,
    updatedAt: '2026-08-29T00:00:00Z',
  }), true);
  assert.equal(isPlaceholderAction({
    label: 'do draft a reply to @agents opening on the OpenRouter weekly cap',
    brief: 'Open with: "the weekly cap is the constraint, not the model." Destination: their thread. Draft only.',
    href: 'https://x.com/a',
    updatedAt: '2026-08-29T00:00:00Z',
  }), false);
});

// Label prefixes used to count as placeholders too, which silently ate owner-typed
// labels: the save returned 200 and the action then vanished from the card, with
// do-prompt answering 'item has no action'. A researched brief keeps the action.
test('an owner label that reads like a template survives when its brief is real', () => {
  for (const label of [
    'do draft a reply on X about their OpenRouter bill',
    'do qualify and draft a reply to their CTO',
    'do assess the HN thread and draft if it qualifies — they named a $40k bill',
  ]) {
    assert.equal(
      isPlaceholderAction({
        label,
        brief: 'Open on the invoice line they quoted. Destination: the thread. Draft only.',
        href: 'https://example.com/1',
        updatedAt: '2026-08-29T00:00:00Z',
      }),
      false,
      `must survive: ${label}`,
    );
  }
});

test('actionFromOutreachNotes lifts a hunt draft into a send action', () => {
  assert.equal(actionFromOutreachNotes([], 'https://x.com/a'), null);
  const action = actionFromOutreachNotes([
    { at: '2026-08-29T00:00:00Z', text: 'outreach draft (seller):\nYour M5 Max has enough memory. We serve that shape.' },
  ], 'https://x.com/a/status/1', '2026-08-29T01:00:00Z');
  assert.equal(action?.label, 'do send the outreach draft');
  assert.equal(action?.href, 'https://x.com/a/status/1');
  assert.match(action?.brief ?? '', /Your M5 Max has enough memory/);
  assert.match(action?.brief ?? '', /Artifact:/);
  assert.match(action?.brief ?? '', /Open with:/);
  assert.equal(isPlaceholderAction(action), false);
});

test('buildDoPrompt names missing context instead of going silent', () => {
  const prompt = buildDoPrompt(item, {
    generatedAt: '2026-08-29T12:00:00Z',
    stateBrief: null,
    stateBriefPath: null,
    productMarketing: null,
    productMarketingPath: null,
  });
  assert.match(prompt, /VERIFIED FACTS you must weigh/);
  assert.match(prompt, /MISSING facts.json/);
  assert.match(prompt, /MISSING state-brief.md/);
  assert.match(prompt, /MISSING product-marketing.md/);
  assert.match(prompt, /do draft a reply/);
  assert.match(prompt, /s-1/);
});

test('buildDoPrompt live roster wins over product-marketing.md', () => {
  const withRoster = buildDoPrompt(item, {
    generatedAt: '2026-08-29T12:00:00Z',
    stateBrief: 'Accounts: 2',
    stateBriefPath: 'x',
    productMarketing: 'In bring-up, not sellable: stepfun/step-3.7-flash.',
    productMarketingPath: 'y',
    liveRoster: 'as_of 2026-08-29. serving `stepfun/step-3.7-flash` $0.20 in',
  });
  // Assert the ROSTER header, not the JUDGE boilerplate: /wins over product-marketing/
  // is in every prompt, including the no-roster one, so it proved nothing about the branch.
  assert.match(withRoster, /Live roster \(facts\.json — wins on models, prices, speed\)/);
  assert.match(withRoster, /stepfun\/step-3\.7-flash/);

  const withoutRoster = buildDoPrompt(item, {
    generatedAt: '2026-08-29T12:00:00Z',
    stateBrief: 'Accounts: 2',
    stateBriefPath: 'x',
    productMarketing: 'y',
    productMarketingPath: 'y',
  });
  assert.equal(/Live roster \(facts\.json/.test(withoutRoster), false, 'no roster, no roster header');
  assert.match(withoutRoster, /MISSING facts\.json/);
});

test('liveRosterFromFacts reads the real facts.json shape and marks unpublished rows', () => {
  const roster = liveRosterFromFacts(JSON.stringify({
    as_of: '2026-08-29',
    models: [
      {
        id: 'qwen/qwen3.8-27b',
        status: 'serving',
        published: true,
        contextTokens: 262144,
        pricing: { input: 0.2, cachedInput: 0.05, output: 0.6 },
        perf: { decodeFastTokensPerSecond: { headline: 119.5 } },
      },
      { id: 'vendor/in-bringup', status: 'bring-up', published: false },
      { status: 'serving' },
    ],
  }));
  assert.match(roster, /as_of 2026-08-29/);
  assert.match(roster, /`qwen\/qwen3\.8-27b` 262144 ctx \$0\.2 in \/ \$0\.05 cached \/ \$0\.6 out up to 119\.5 tok\/s/);
  assert.match(roster, /bring-up unpublished `vendor\/in-bringup`/);
  assert.equal(roster.includes('- serving\n'), false, 'a row with no id is skipped, not printed empty');
});

// `exec` here made every line after it dead code, so a failed launch left no session
// and no reason anywhere while the API had already answered launched:true.
test('launchScript does not exec the agent, so the status line and holding shell run', () => {
  const script = launchScript('claude', '/usr/bin/claude', '/home/x/projects/darklanes', '/tmp/p.md');
  assert.equal(/^\s*exec '\/usr\/bin\/claude'/mu.test(script), false, 'the agent must not be exec-ed');
  assert.match(script, /^'\/usr\/bin\/claude' --model opus "\$prompt"$/mu);
  assert.match(script, /status=\$\?/);
  assert.match(script, /exec "\$\{SHELL:-\/bin\/bash\}"/);
  const codex = launchScript('codex', '/usr/bin/codex', '/home/x/projects/darklanes', '/tmp/p.md');
  assert.match(codex, /^'\/usr\/bin\/codex' --search -C '\/home\/x\/projects\/darklanes' "\$prompt"$/mu);
});

test('buildDoPrompt refuses a missing action', () => {
  assert.throws(() => buildDoPrompt({ ...item, action: null }, {
    generatedAt: '2026-08-29T12:00:00Z',
    stateBrief: 'ok',
    stateBriefPath: 'x',
    productMarketing: 'ok',
    productMarketingPath: 'y',
  }), /no action/);
});
