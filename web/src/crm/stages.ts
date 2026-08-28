import type { CrmItem, CrmStage } from '../../../shared/types';

/** Runtime twin of the CrmStage union — see the note in shared/types.ts on why
 *  the array cannot live there. Order = board order. */
export const CRM_STAGES = ['new', 'contacted', 'replied', 'signed-up', 'active', 'paying', 'skipped', 'lost'] as const satisfies readonly CrmStage[];
type _Complete = CrmStage extends (typeof CRM_STAGES)[number] ? true : never;
export const _complete: _Complete = true;

/**
 * The stages the PIPELINE board can actually hold.
 *
 * `signed-up`, `active` and `paying` are account lifecycle states: derivedAccountStage is the only
 * thing that produces them (suspended -> lost, paid -> paying, requests > 1 -> active, else
 * signed-up), and derivedLeadStage only ever returns new / contacted / skipped. Accounts live on the
 * users screen now, so those three columns rendered "0 / empty" on every load and always would.
 *
 * `replied` stays: a lead genuinely reaches it once someone answers, even though it is empty today.
 * An empty column that a row can enter is a destination; one that nothing can ever enter is noise.
 *
 * `skipped` and `lost` are both closed, but they are different decisions: skipped = triaged away
 * without engaging (most thread leads end here), lost = we engaged and it died.
 */
export const PIPELINE_STAGES = ['new', 'contacted', 'replied', 'skipped', 'lost'] as const satisfies readonly CrmStage[];

export const STAGE_LABEL: Record<CrmStage, string> = {
  'new': 'new',
  contacted: 'contacted',
  replied: 'replied',
  'signed-up': 'signed up',
  active: 'active',
  paying: 'paying',
  skipped: 'skipped',
  lost: 'lost',
};

/** Sources where the action is a public comment on a thread, not a mail to a
 *  person. The stage machinery is identical; only the words change — "contacted"
 *  on an X thread misdescribes what happened, which is that we commented. */
const COMMENT_SOURCES = new Set(['x', 'hn', 'reddit', 'hf-hub', 'gh-issue', 'github-pr', 'gh-code', 'youtube', 'blog']);

const COMMENT_LABEL: Partial<Record<CrmStage, string>> = {
  contacted: 'commented',
  replied: 'comment back',
};

/** The stage word that fits what actually happens on this item's channel. */
export function stageLabelFor(item: Pick<CrmItem, 'kind' | 'source'>, stage: CrmStage): string {
  if (item.kind === 'lead' && item.source && COMMENT_SOURCES.has(item.source)) {
    return COMMENT_LABEL[stage] ?? STAGE_LABEL[stage];
  }
  return STAGE_LABEL[stage];
}

/** Palette roles, not colors: amber marks the stages that want a next touch,
 *  jade the healthy ones, coral the terminal one. */
export const STAGE_TONE: Record<CrmStage, string> = {
  'new': 'text-amber',
  contacted: 'text-slate-glow',
  replied: 'text-amber',
  'signed-up': 'text-slate-glow',
  active: 'text-jade',
  paying: 'text-jade',
  skipped: 'text-mist-faint',
  lost: 'text-mist-faint',
};
