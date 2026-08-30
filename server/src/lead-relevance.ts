import type { CrmItem } from '../../shared/types.js';

/**
 * Lead relevance = company / line-item buyer, not "anyone paying a provider".
 *
 * A personal weekly-cap vent ($200 Claude, a burned OpenClaw budget, a solo 402)
 * used to score as qualified because the old weights treated any dollar figure or
 * rate limit as a buyer. That filled the board with 150 noise rows. Qualified now
 * means a cost line someone at a company watches, or spend at line-item scale.
 *
 * The rules are patterns, not memories. The first pass of this rewrite hardcoded
 * fragments of the posts that survived the 2026-08-29 purge (`18x`, `100,?000%`,
 * `$3,000`, `58K USD`, `60b monthly`, `ZDR`), which made the regression test pass
 * by memorization while the scorer misfired on everything phrased differently:
 * "the kernel is 18x faster" and "I agree 100000%" qualified at +8, and
 * "we spend $15,000 monthly on OpenAI and are evaluating alternatives" scored 0.
 * That matters more than ranking now, because demand.ts uses `qualified` as a
 * hard create-gate: a miss here is a lead that never appears at all.
 *
 * Two structural rules hold the shape:
 *  - money and token volume only count WITH spend context, so a $3,000 laptop and
 *    a 500-billion-token training run are not buyers.
 *  - WEAK signals are clamped below QUALIFIED_AT, so they can never qualify a post
 *    on their own; they only sharpen a post that already carries company evidence.
 *    This is what keeps buyer profile #2 (always-on personal-agent operators) alive
 *    without re-admitting the vents: a cap complaint plus provider shopping is a
 *    lead, a cap complaint alone is not.
 *
 * Keep this file in lockstep with
 * `/home/avifenesh/.hermes/profiles/seller/scripts/lead-create-bar.py` — that
 * gate is what the X ingest agent runs before a row is written.
 */

interface Rule {
  pattern: RegExp;
  /** Second condition on the same text. Money alone is not a signal; money someone spends is. */
  requires?: RegExp;
  points: number;
  label: string;
}

/** Someone talking about paying for something, in any tense. */
const SPEND_CONTEXT =
  /\b(?:spend|spends|spending|spent|bill|bills|billing|billed|budget|cost|costs|costing|invoice|invoiced|pay|pays|paying|paid|burn|burned|burning|charged|priced|pricing|monthly|per month|a month)\b/i;

/** Money at a scale a company reviews: k/m suffixes, thousands separators, four figures. */
const MONEY_AT_SCALE =
  /(?:five|six)[- ]figures?|(?:\$|usd\s?\$?|eur|€|£)\s?\d[\d.,]*\s?[km]\b|\b\d[\d.,]*\s?[km]\s?(?:usd|eur|gbp)\b|(?:\$|usd\s?\$?|€|£)\s?\d{1,3}(?:,\d{3})+|(?:\$|usd\s?\$?|€|£)\s?\d{4,}|\b\d{2,}\s?k\s?(?:\/\s?mo\b|per month|a month|monthly|this month)/i;

/** Token volume at a scale nobody reaches by hand. */
const TOKEN_VOLUME =
  /\b\d+(?:[.,]\d+)?\s*(?:b|m|billion|million)\b[^.]{0,20}?\btokens?\b|\btokens?\b[^.]{0,24}?\b\d+(?:[.,]\d+)?\s*(?:b|m|billion|million)\b|\b\d+(?:[.,]\d+)?\s?[mb]\b[- ]?(?:input|output)\b/i;

/** Enough alone: evidence of a company, a production workload, or business-scale spend. */
const STRONG: Rule[] = [
  { pattern: MONEY_AT_SCALE, requires: SPEND_CONTEXT, points: 6, label: 'line-item spend' },
  { pattern: TOKEN_VOLUME, requires: SPEND_CONTEXT, points: 6, label: 'token volume at scale' },
  {
    pattern: /\b\d{2,}\+?\s*(?:concurrent|parallel|simultaneous|rps|qps)\b|\b(?:concurrency|throughput) of \d{2,}/i,
    points: 6,
    label: 'concurrency scale',
  },
  {
    pattern:
      /\b(?:our|the)\s+(?:openai|anthropic|claude|gemini|openrouter|inference|api|llm|token|model)\s+(?:bill|spend|costs?|invoice)\b|our inference costs?|\bbill went (?:from|up)\b|\bbill (?:doubled|tripled|exploded)\b/i,
    points: 6,
    label: 'names a company bill',
  },
  {
    pattern:
      /\b(?:we|our)\b.{0,80}\b(?:bill|team|company|startup|users|customers|clients|product|platform|legal|finance|procurement|mrr|revenue|inference costs?|prod(?:uction)?)\b/i,
    points: 6,
    label: 'company voice',
  },
  {
    pattern:
      /\bin prod(?:uction)?\b|\b(?:for|at|run|running) (?:our|my) (?:[\w-]+ and )?(?:\d+[- ]person )?(?:startup|company|team|clients|customers|agency)\b|\bour (?:app|product|service|agents?|api|platform|users)\b/i,
    points: 6,
    label: 'production workload',
  },
  {
    pattern:
      // Counts spelled either way: "two companies" is the same buyer as "2 companies".
      /\bcustomer (?:support|service|facing|chat)\b|\benterprise\b|\bcorporate\b|\bagency\b|\bsaas\b|\bb2b\b|\b\d+[- ]person (?:team|startup|company)\b|\b(?:i|we) run (?:\d+|two|three|four|five|several|multiple) (?:companies|startups|teams)\b|\b(?:\d+|two|three|four|five) (?:companies|startups|clients)\b/i,
    points: 6,
    label: 'business context',
  },
  {
    pattern:
      /\b(?:looking|shopping|evaluating|comparing) (?:at |for )?[^.]{0,50}\b(?:provider|api|endpoint|host|inference|alternative)|\bmigrat(?:e|ing|ion)\b[^.]{0,50}\b(?:from|off|provider|openrouter|fireworks|together|bedrock|vertex|stack)\b|\bswitch(?:ing|ed)?\b[^.]{0,50}\bprovider\b|\b(?:openrouter|fireworks|together|deepinfra|groq|novita|bedrock)\b[^.]{0,24}\bvs\b|\bwe (?:use|route through|are on)\b[^.]{0,30}\b(?:openrouter|fireworks|together|bedrock|vertex)\b|\bdecouple\b[^.]{0,24}\b(?:openrouter|provider|vendor)\b/i,
    points: 6,
    label: 'provider shopping',
  },
  {
    pattern:
      /custom base_?url|openai[- ]compatible|anthropic[- ]compatible|drop.?in replacement|managed (?:api|endpoint|inference)|\bdirect (?:api )?(?:connection|contract|access)\b/i,
    points: 5,
    label: 'wants a hosted endpoint',
  },
  {
    pattern:
      /\b(?:invoice|purchase order|contract|quote|procurement|startup credits|annual (?:plan|commit(?:ment)?)|volume (?:pricing|discount)|enterprise (?:plan|pricing|tier)|reload cap|auto.?reload)\b|\b(?:billing|invoice) (?:control|failure|surprise|issue|shock)\b/i,
    points: 5,
    label: 'purchase intent',
  },
];

/** Personal spend / caps. Clamped below QUALIFIED_AT — never enough alone. */
const WEAK: Rule[] = [
  { pattern: /\$\s?[\d,]+\s?(?:\/\s?mo|per month|a month|\/month)/i, points: 2, label: 'names a personal bill' },
  { pattern: /rate.?limit|\b429\b|\b402\b|weekly (?:limit|cap)|out of credits|hit the (?:weekly )?cap/i, points: 2, label: 'hit a cap' },
  { pattern: /always.?on|running (?:all day|24\/7)|subagent/i, points: 2, label: 'always-on agent' },
];

const DISQUALIFIERS: Rule[] = [
  {
    pattern: /\b(?:[3-5]0[6-9]0|[3-5]090|vram|gguf|llama\.cpp|exllama|quantiz|offload|tensor split|m[1-5] (?:max|pro|ultra)|mlx|unified memory|gaming (?:pc|laptop|rig)|mac ?(?:book|studio|mini))\b/i,
    points: -8,
    label: 'own hardware',
  },
  {
    pattern: /run(?:ning)? (?:it )?local|local (?:inference|model|setup|llm)|lm studio|\bollama\b(?!\s+cloud\b)|self.?host/i,
    points: -6,
    label: 'local only',
  },
];

/** A vent about a personal plan's ceiling. Only applied when nothing STRONG matched:
 *  a company saying "our team hit the weekly cap" is a buyer describing a constraint. */
const PERSONAL_CAP_VENT: Rule = {
  pattern: /hit the (?:weekly )?cap|weekly (?:limit|cap) got exhausted|need more (?:openrouter )?credits|openclaw was burning|burned \$ in days/i,
  points: -8,
  label: 'personal cap vent',
};

export interface Relevance {
  score: number;
  labels: string[];
  qualified: boolean;
}

/** Score >= this is a lead worth creating or keeping on the board. */
export const QUALIFIED_AT = 5;

/** WEAK signals together stay under the bar, so they decide nothing on their own. */
const WEAK_CAP = QUALIFIED_AT - 1;

export function scoreLead(item: Pick<CrmItem, 'title' | 'subtitle' | 'detail' | 'kind'>): Relevance {
  if (item.kind !== 'lead') return { score: QUALIFIED_AT, labels: [], qualified: true };

  const text = [item.title, item.subtitle, item.detail].filter(Boolean).join(' ');
  let score = 0;
  let weak = 0;
  let strongHits = 0;
  const labels: string[] = [];

  for (const rule of STRONG) {
    if (!rule.pattern.test(text)) continue;
    if (rule.requires && !rule.requires.test(text)) continue;
    score += rule.points;
    strongHits += 1;
    labels.push(rule.label);
  }
  for (const rule of WEAK) {
    if (!rule.pattern.test(text)) continue;
    weak += rule.points;
    labels.push(rule.label);
  }
  score += Math.min(weak, WEAK_CAP);
  for (const rule of DISQUALIFIERS) {
    if (!rule.pattern.test(text)) continue;
    score += rule.points;
    labels.push(rule.label);
  }
  if (strongHits === 0 && PERSONAL_CAP_VENT.pattern.test(text)) {
    score += PERSONAL_CAP_VENT.points;
    labels.push(PERSONAL_CAP_VENT.label);
  }

  return { score, labels, qualified: score >= QUALIFIED_AT };
}
