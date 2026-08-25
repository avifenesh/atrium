import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALIFIED_AT, scoreLead } from './lead-relevance.js';

// These are the real rows from the live pipeline, which is the point: the scorer is judged on the
// posts it actually has to rank, not on invented sentences that happen to match its own regexes.
//
// Before ranking existed the pipeline showed 153 unsorted rows at stage=new, of which 28 carried a
// buying signal, 149 carried none, and 23 were disqualified. The $18k-bill row sorted no higher than
// a Torah lecture containing the word "tiyuvta".

const lead = (title: string, subtitle: string | null = null) =>
  ({ kind: 'lead' as const, title, subtitle, detail: null });

test('a named bill with agents in production is the strongest signal', () => {
  const r = scoreLead(lead(
    'our openai bill went from $2k to $18k this month after putting agents in prod. looking at openrouter vs fireworks',
  ));
  assert.ok(r.qualified, 'must qualify');
  // Several independent signals: a bill, an escalation, production, and shopping.
  assert.ok(r.score >= 15, `expected a high score, got ${r.score}`);
  assert.ok(r.labels.includes('names a bill'));
  assert.ok(r.labels.includes('provider shopping'));
});

test('a price rise driving a migration qualifies', () => {
  const r = scoreLead(lead('Switched to codex since deepseek literally doubled their API pricing'));
  assert.ok(r.qualified, `expected qualified, got ${r.score}`);
});

test('a paid plan hitting its limit qualifies', () => {
  const r = scoreLead(lead(
    "I'm on $200/month claude plan, fable weekly limit got exhausted in just 2.5 days",
  ));
  assert.ok(r.qualified, `expected qualified, got ${r.score}`);
});

test('an agent dying on a provider 402 qualifies', () => {
  const r = scoreLead(lead(
    'A subagent I was running hit an OpenRouter 402 mid-task. Out of credits, dead stop.',
  ));
  assert.ok(r.qualified, `expected qualified, got ${r.score}`);
});

test('own-hardware tuning is disqualified however detailed', () => {
  for (const title of [
    'VRAM plan collapses KV to 128 blocks at max_batch_size=16 on Qwen3.8-27B-NVFP4',
    'Your M5 Max has enough memory to load the model, but memory bandwidth limits generation speed',
    'this 12GB 3060 fits the model but 64K context blows up VRAM',
  ]) {
    const r = scoreLead(lead(title));
    assert.equal(r.qualified, false, `should not qualify: ${title}`);
    assert.ok(r.score < 0, `expected a negative score for ${title}, got ${r.score}`);
  }
});

test('local-only interest is disqualified', () => {
  const r = scoreLead(lead('Running it locally + getting good results, using ollama'));
  assert.equal(r.qualified, false);
});

test('a brand mention with no commercial content scores neutral, not qualified', () => {
  const r = scoreLead(lead("R' Yechezkel Hartman | Short Machshava - Bava Batra 52 - Kashya and Tiyuvta"));
  assert.equal(r.score, 0);
  assert.equal(r.qualified, false);
});

test('hardware pain cannot be rescued by an incidental money word', () => {
  // A post about a 4090 that mentions a subscription must still lose: the disqualifier outweighs a
  // weak signal, which is what keeps hobbyists off the top of the list.
  const r = scoreLead(lead('my 4090 runs it fine, cheaper than my $20 subscription'));
  assert.equal(r.qualified, false, `got ${r.score} with labels ${r.labels.join(', ')}`);
});

test('a direction is our own work and is never scored down', () => {
  const r = scoreLead({
    kind: 'direction',
    title: 'Add tiyuvta to PromptLayer’s provider documentation',
    subtitle: null,
    detail: null,
  });
  assert.ok(r.qualified);
  assert.equal(r.score, QUALIFIED_AT);
});

test('labels explain the score, so ranking is never a black box', () => {
  const r = scoreLead(lead('we run agents in production and are looking for a cheaper provider'));
  assert.ok(r.labels.length >= 2, 'a multi-signal row must name its signals');
  assert.ok(r.qualified);
});
