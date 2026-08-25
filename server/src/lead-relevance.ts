import type { CrmItem } from '../../shared/types.js';

/**
 * Lead relevance, scored against the target: companies and heavy users running always-on agents.
 *
 * Why this exists. The pipeline had 153 rows at stage=new with no ordering, and only 28 of them
 * carried any buying signal at all: 149 had no signal either way and 23 were outright disqualified
 * (VRAM budgets, a 3060, MLX, "run it locally"). An unranked list of 153 makes the owner do the
 * triage the collector should have done, and the one row that says
 *
 *   "our openai bill went from $2k to $18k this month after putting agents in prod"
 *
 * sorted no higher than a Torah lecture that happens to contain the word "tiyuvta".
 *
 * The weights are not taste. They mirror the qualifying signals in the target directive: a production
 * workload, current spend with another provider, provider shopping, a stated budget, purchase intent,
 * or an explicit managed-API request. Disqualifiers mirror the standing rule that someone debugging
 * their own GPU is not a buyer.
 */

interface Rule {
  pattern: RegExp;
  points: number;
  label: string;
}

/** Money named out loud is the strongest signal a stranger can give us. */
const SIGNALS: Rule[] = [
  { pattern: /\$\s?[\d,]+\s?(?:k\b|\/\s?mo|per month|a month|month)/i, points: 6, label: 'names a bill' },
  { pattern: /bill went from|doubled (?:their|the) pric|pric(?:e|ing) (?:doubled|went up|increase)|too expensive/i, points: 6, label: 'cost escalation' },
  { pattern: /\bin prod(?:uction)?\b|our (?:app|product|service|agents?|api|platform|users)|for (?:our|my) (?:startup|company|team)/i, points: 5, label: 'production workload' },
  { pattern: /looking (?:at|for) (?:a )?(?:another |different |cheaper )?(?:provider|api|endpoint|host)|which (?:api|provider|host)|\bvs\b.*\b(?:openrouter|fireworks|together|deepinfra|groq|novita)\b|migrat(?:e|ing) (?:from|off)|switch(?:ed|ing) (?:from|off|to)/i, points: 5, label: 'provider shopping' },
  { pattern: /always.?on|running (?:all day|24\/7|continuously)|agents? (?:in prod|running|loop)|subagent/i, points: 5, label: 'always-on agent' },
  { pattern: /custom base_?url|openai[- ]compatible|anthropic[- ]compatible|drop.?in replacement|managed (?:api|endpoint|inference)/i, points: 4, label: 'wants a hosted endpoint' },
  { pattern: /rate.?limit|\b429\b|\b402\b|out of credits|quota|usage tier|weekly limit|exhaust/i, points: 3, label: 'hit a provider limit' },
  { pattern: /paid (?:plan|model|api|tier|subscription)|subscription|invoice|\bbilling\b/i, points: 3, label: 'already paying' },
];

/** Tuning your own rig is the hobby, not the purchase. */
const DISQUALIFIERS: Rule[] = [
  {
    pattern: /\b(?:[3-5]0[6-9]0|[3-5]090|vram|gguf|llama\.cpp|exllama|quantiz|offload|tensor split|m[1-5] (?:max|pro|ultra)|mlx|unified memory)\b/i,
    points: -8,
    label: 'own hardware',
  },
  {
    pattern: /run(?:ning)? (?:it )?local|local (?:inference|model|setup|llm)|lm studio|\bollama\b|self.?host/i,
    points: -6,
    label: 'local only',
  },
];

export interface Relevance {
  score: number;
  labels: string[];
  qualified: boolean;
}

/** Score >= this is a lead worth the owner's next tick. */
export const QUALIFIED_AT = 5;

export function scoreLead(item: Pick<CrmItem, 'title' | 'subtitle' | 'detail' | 'kind'>): Relevance {
  // A direction is our own work item, not a stranger's post: it is always relevant and never scored.
  if (item.kind !== 'lead') return { score: QUALIFIED_AT, labels: [], qualified: true };

  const text = [item.title, item.subtitle, item.detail].filter(Boolean).join(' ');
  let score = 0;
  const labels: string[] = [];
  for (const rule of [...SIGNALS, ...DISQUALIFIERS]) {
    if (rule.pattern.test(text)) {
      score += rule.points;
      labels.push(rule.label);
    }
  }
  return { score, labels, qualified: score >= QUALIFIED_AT };
}
