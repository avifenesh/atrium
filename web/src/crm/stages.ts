import type { CrmStage } from '../../../shared/types';

/** Runtime twin of the CrmStage union — see the note in shared/types.ts on why
 *  the array cannot live there. Order = board order. */
export const CRM_STAGES = ['new', 'contacted', 'replied', 'signed-up', 'active', 'paying', 'lost'] as const satisfies readonly CrmStage[];
type _Complete = CrmStage extends (typeof CRM_STAGES)[number] ? true : never;
export const _complete: _Complete = true;

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
