// Kanban board — the desktop pipeline view: one column per stage, cards in
// funnel order. The phone list view stays in CrmApp; this renders only ≥lg.
//
// Cards MOVE: native HTML5 drag, drop on a column pins that stage via the same
// /api/crm/entry override the drawer uses. Dropping on the card's derived stage
// clears the override instead — same semantics as tapping it in the drawer.

import { useState } from 'react';
import type { CrmItem, CrmStage } from '../../../shared/types';
import { DoLink } from './Action';
import { PIPELINE_STAGES, STAGE_TONE, stageLabelFor } from './stages';

const KIND_TONE: Record<CrmItem['kind'], string> = {
  direction: 'text-amber',
  lead: 'text-slate-glow',
  account: 'text-jade',
};

function BoardCard({ item, onOpen }: { item: CrmItem; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/crm-item-id', item.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the card itself: Enter on the nested Do button must launch, not open.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="block w-full cursor-grab rounded-lg border border-white/8 bg-ink-2 px-2.5 py-2 text-left transition-colors hover:border-white/20 active:cursor-grabbing"
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
      <DoLink item={item} compact />
    </div>
  );
}

export function Board({
  items,
  onOpen,
  onMove,
}: {
  items: CrmItem[];
  onOpen: (id: string) => void;
  /** Move an item to a stage (null = clear the override, back to derived). */
  onMove: (id: string, stage: CrmStage | null) => void;
}) {
  const [dropStage, setDropStage] = useState<CrmStage | null>(null);
  const byId = new Map(items.map((i) => [i.id, i]));
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
        // Column headers speak the majority channel of the column's cards; a mixed
        // column falls back to the generic word. One header cannot fit every card,
        // but "commented 12" over twelve X leads beats "contacted 12".
        const sample = column[0];
        const header = sample ? stageLabelFor(sample, stage) : stageLabelFor({ kind: 'lead', source: null }, stage);
        return (
          <div
            key={stage}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/crm-item-id')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropStage(stage);
              }
            }}
            onDragLeave={() => setDropStage((s) => (s === stage ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              setDropStage(null);
              const id = e.dataTransfer.getData('text/crm-item-id');
              const item = id ? byId.get(id) : undefined;
              if (!item || item.stage === stage) return;
              // dropping onto the derived stage = clear the override, not pin it
              onMove(id, stage === item.derivedStage ? null : stage);
            }}
            className={`w-60 shrink-0 rounded-xl border bg-white/[0.015] xl:w-64 ${
              dropStage === stage ? 'border-white/30 bg-white/[0.04]' : 'border-white/8'
            }`}
          >
            <div className="flex items-baseline justify-between px-2.5 pb-1 pt-2">
              <span className={`font-mono text-[11px] ${STAGE_TONE[stage]}`}>{header}</span>
              <span className="font-mono text-[10px] text-mist-faint">{column.length}</span>
            </div>
            <div className="max-h-[62vh] space-y-1.5 overflow-y-auto p-1.5 pt-0.5">
              {column.map((item) => (
                <BoardCard key={item.id} item={item} onOpen={() => onOpen(item.id)} />
              ))}
              {column.length === 0 && (
                <div className="rounded-lg border border-dashed border-white/8 px-2 py-3 text-center font-mono text-[10px] text-mist-faint">
                  {dropStage === stage ? 'drop here' : 'empty'}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
