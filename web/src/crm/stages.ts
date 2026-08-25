import type { CrmStage } from '../../../shared/types';

/** Runtime twin of the CrmStage union — see the note in shared/types.ts on why
 *  the array cannot live there. Order = board order. */
export const CRM_STAGES = ['new', 'contacted', 'replied', 'signed-up', 'active', 'paying', 'lost'] as const satisfies readonly CrmStage[];
type _Complete = CrmStage extends (typeof CRM_STAGES)[number] ? true : never;
export const _complete: _Complete = true;

/**
 * The stages the PIPELINE board can actually hold.
 *
 * `signed-up`, `active` and `paying` are account lifecycle states: derivedAccountStage is the only
 * thing that produces them (suspended -> lost, paid -> paying, requests > 1 -> active, else
 * signed-up), and derivedLeadStage only ever returns new / contacted / lost. Accounts live on the
 * users screen now, so those three columns rendered "0 / empty" on every load and always would.
 *
 * `replied` stays: a lead genuinely reaches it once someone answers, even though it is empty today.
 * An empty column that a row can enter is a destination; one that nothing can ever enter is noise.
 */
export const PIPELINE_STAGES = ['new', 'contacted', 'replied', 'lost'] as const satisfies readonly CrmStage[];

export const STAGE_LABEL: Record<CrmStage, string> = {
  'new': 'new',
  contacted: 'contacted',
  replied: 'replied',
  'signed-up': 'signed up',
  active: 'active',
  paying: 'paying',
  lost: 'lost',
};

/** Palette roles, not colors: amber marks the stages that want a next touch,
 *  jade the healthy ones, coral the terminal one. */
export const STAGE_TONE: Record<CrmStage, string> = {
  'new': 'text-amber',
  contacted: 'text-slate-glow',
  replied: 'text-amber',
  'signed-up': 'text-slate-glow',
  active: 'text-jade',
  paying: 'text-jade',
  lost: 'text-mist-faint',
};
