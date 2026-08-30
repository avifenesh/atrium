import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALIFIED_AT, scoreLead } from './lead-relevance.js';

const lead = (title: string, subtitle: string | null = null) =>
  ({ kind: 'lead' as const, title, subtitle, detail: null });

// The corpus below is paraphrased on purpose. The shapes are the ones the scorer has
// to rank; the wording is not. Verbatim prospect posts are reverse-searchable and this
// repo is public, so a handle or an attributed spend figure here would publish who we
// are talking to and what we think they spend. Real rows stay in the private lane.

test('a named company bill with agents in production is the strongest signal', () => {
  const r = scoreLead(lead(
    'our openai bill went from $2k to $18k this month after putting agents in prod. looking at openrouter vs fireworks',
  ));
  assert.ok(r.qualified, 'must qualify');
  assert.ok(r.score >= 15, `expected a high score, got ${r.score}`);
  assert.ok(r.labels.includes('names a company bill'));
  assert.ok(r.labels.includes('provider shopping'));
});

test('personal price-rise migration does not qualify', () => {
  const r = scoreLead(lead('Switched to codex since deepseek literally doubled their API pricing'));
  assert.equal(r.qualified, false, `personal vent must not qualify, got ${r.score}`);
});

test('personal weekly-cap vent does not qualify', () => {
  const r = scoreLead(lead(
    "I'm on $200/month claude plan, fable weekly limit got exhausted in just 2.5 days",
  ));
  assert.equal(r.qualified, false, `personal cap must not qualify, got ${r.score} ${r.labels.join(',')}`);
});

test('solo 402 / out of credits does not qualify', () => {
  const r = scoreLead(lead(
    'A subagent I was running hit an OpenRouter 402 mid-task. Out of credits, dead stop.',
  ));
  assert.equal(r.qualified, false, `solo 402 must not qualify, got ${r.score}`);
});

test('a 2-person startup naming a monthly tool bill is a company', () => {
  const r = scoreLead(lead('i pay $200/month in AI tools to run my 2-person startup. half my stack broke'));
  assert.ok(r.qualified, `expected qualified, got ${r.score} ${r.labels.join(',')}`);
});

test('the buyer shapes kept by the 2026-08-29 bar qualify', () => {
  for (const title of [
    'we spend five figures a month with that provider directly via API',
    'I spend 20k per month on one model and the flash one answers faster',
    'switching our provider from one serverless host to another for a coding model',
    'our inference costs more than our mrr at this point',
    'the customer support chat we ship costs $131 a week in raw tokens',
    'our legal team told us to decouple from the gateway we resell through',
    'how do we get startup credits? we use a gateway today, how do we migrate?',
    'i am on a similar monthly budget for my projects and clients',
    'the harness experiment for team-based work as a corporate agent failed',
    'i priced a 10M-input + 2M-output agent workload at $110 for the month',
    'our provider bill went up overnight after we upgraded our agents',
    'token cost if that shop paid list API pricing: 58k USD billed in 28 days',
    'we spent $3000 in tokens last month for a 3 person team',
    'moving my 60b monthly tokens somewhere cheaper',
    'we route through a gateway today but are open to a direct connection for our users',
    'spent weeks evaluating gateways to migrate our enterprise stack',
    'i run two companies solo and agent spend is my biggest monthly cost',
    'lifetime tokens burned is around 25 billion, roughly USD$18,082',
    '100+ concurrent requests is the part worth sizing',
    'the auto-reload cap was ignored and that is a billing control failure',
  ]) {
    const r = scoreLead(lead(title));
    assert.ok(r.qualified, `should qualify (${r.score}): ${title}`);
  }
});

// Each of these matched a memorized fragment of the kept corpus at +8 in the first
// rewrite, so a perf claim and a hyperbole idiom outranked real buyers on the board.
test('post-shaped noise that memorized literals used to qualify stays out', () => {
  for (const title of [
    'benchmarked the new kernel: 18x faster than the reference on the same card',
    'I agree 100000% with this take on agent harnesses',
    'just bought a $3,000 gaming laptop for the trip',
    'trained on 500 billion tokens over the weekend',
    'ZDR support just landed in the nightly build',
    'the release notes say 100+ new tests, not concurrent anything',
  ]) {
    const r = scoreLead(lead(title));
    assert.equal(r.qualified, false, `should not qualify (${r.score} ${r.labels.join(',')}): ${title}`);
  }
});

// The other half of the memorization bug: textbook buyers the first rewrite scored 0,
// which demand.ts would drop at ingest so they never reach the board at all.
test('ICP-law signals qualify even when phrased nothing like the corpus', () => {
  for (const title of [
    'we spend $15,000 monthly on one provider and are evaluating alternatives',
    'looking for a drop-in replacement for that API, we need an invoice and a contract',
    'anyone offer an openai-compatible endpoint with volume pricing?',
    'we need a managed endpoint our platform can point a custom base_url at',
    'our team runs 300 concurrent requests at peak',
  ]) {
    const r = scoreLead(lead(title));
    assert.ok(r.qualified, `should qualify (${r.score} ${r.labels.join(',')}): ${title}`);
  }
});

// Buyer profile #2 stays reachable: the cap complaint is not the signal, the paid
// always-on workload plus shopping is. Clamped weak points make that difference.
test('weak signals alone never qualify, but they sharpen a shopping post', () => {
  const vent = scoreLead(lead('on the $200/month plan, rate limits all day, my subagent loop runs 24/7'));
  assert.equal(vent.qualified, false, `weak-only must not qualify, got ${vent.score} ${vent.labels.join(',')}`);
  assert.ok(vent.score < QUALIFIED_AT);

  const shopping = scoreLead(lead(
    'on the $200/month plan, my agent runs 24/7 and I am looking for a cheaper provider for it',
  ));
  assert.ok(shopping.qualified, `weak + shopping must qualify, got ${shopping.score} ${shopping.labels.join(',')}`);
});

test('a cap complaint in a company voice is a constraint, not a vent', () => {
  const r = scoreLead(lead('our team hit the weekly cap again and prod agents stalled for a day'));
  assert.ok(r.qualified, `company + cap must qualify, got ${r.score} ${r.labels.join(',')}`);
  assert.equal(r.labels.includes('personal cap vent'), false, 'the vent penalty is for posts with no company evidence');
});

test('ollama cloud is a hosted buyer; the local-only rule must not swallow other cloud words', () => {
  const local = scoreLead(lead('running it locally with ollama on my box'));
  assert.equal(local.qualified, false);
  assert.ok(local.labels.includes('local only'));

  const tunneled = scoreLead(lead('i just use ollama cloudflare tunnel, no api'));
  assert.ok(tunneled.labels.includes('local only'), 'cloudflare is not ollama cloud — this is still a self-hoster');
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
