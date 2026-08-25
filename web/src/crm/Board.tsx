// Kanban board — the desktop pipeline view: one column per stage, cards in
// funnel order. The phone list view stays in CrmApp; this renders only ≥lg.

import type { CrmItem, CrmStage } from '../../../shared/types';
import { PIPELINE_STAGES, STAGE_LABEL, STAGE_TONE } from './stages';

const KIND_TONE: Record<CrmItem['kind'], string> = {
  direction: 'text-amber',
  lead: 'text-slate-glow',
  account: 'text-jade',
};

function BoardCard({ item, onOpen }: { item: CrmItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full rounded-lg border border-white/8 bg-ink-2 px-2.5 py-2 text-left transition-colors hover:border-white/20"
    >
      <div className="line-clamp-2 text-xs leading-snug text-mist">{item.title}</div>
      <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-mist-faint">
        <span className={KIND_TONE[item.kind]}>{item.kind}</span>
        {item.source && item.source !== 'seller' && <span>{item.source}</span>}
        {item.subtitle && <span className="min-w-0 truncate">{item.subtitle}</span>}
        {item.followUpAt && (
          <span className={`ml-auto shrink-0 ${item.followUpDue ? 'text-amber' : ''}`}>⏰</span>
        )}
      </div>
    </button>
  );
}

export function Board({ items, onOpen }: { items: CrmItem[]; onOpen: (id: string) => void }) {
  const byStage = new Map<CrmStage, CrmItem[]>();
  for (const item of items) {
    const list = byStage.get(item.stage) ?? [];
    list.push(item);
    byStage.set(item.stage, list);
  }
  return (
    <div className="flex items-start gap-2 overflow-x-auto pb-2">
      {PIPELINE_STAGES.map((stage) => {
        const column = byStage.get(stage) ?? [];
        return (
          <div key={stage} className="w-60 shrink-0 rounded-xl border border-white/8 bg-white/[0.015] xl:w-64">
            <div className="flex items-baseline justify-between px-2.5 pb-1 pt-2">
              <span className={`font-mono text-[11px] ${STAGE_TONE[stage]}`}>{STAGE_LABEL[stage]}</span>
              <span className="font-mono text-[10px] text-mist-faint">{column.length}</span>
            </div>
            <div className="max-h-[62vh] space-y-1.5 overflow-y-auto p-1.5 pt-0.5">
              {column.map((item) => (
                <BoardCard key={item.id} item={item} onOpen={() => onOpen(item.id)} />
              ))}
              {column.length === 0 && (
                <div className="rounded-lg border border-dashed border-white/8 px-2 py-3 text-center font-mono text-[10px] text-mist-faint">
                  empty
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
