// Ranked send queue. A kanban with eight empty columns is the wrong shape when
// every open lead sits in new: this is a list you work from the top.

import type { CrmItem } from '../../../shared/types';
import { DoLink } from './Action';
import { age } from './time';

export function LeadList({ items, onOpen }: { items: CrmItem[]; onOpen: (id: string) => void }) {
  if (items.length === 0) {
    return (
      <div className="empty-state px-1 py-10 text-sm text-mist-dim">
        Nothing waiting to send. Near misses live on the activity tab.
      </div>
    );
  }
  return (
    <div className="panel-surface">
      {items.map((item) => (
        <LeadRow key={item.id} item={item} onOpen={() => onOpen(item.id)} />
      ))}
    </div>
  );
}

function LeadRow({ item, onOpen }: { item: CrmItem; onOpen: () => void }) {
  const score = item.relevance?.score;
  const why = item.relevance?.labels[0] ?? null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="surface-row grid cursor-pointer grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber sm:px-4"
    >
      <div
        className={`font-mono text-lg tabular-nums leading-none ${
          (score ?? 0) >= 12 ? 'text-mist' : 'text-mist-dim'
        }`}
      >
        {score ?? '·'}
      </div>
      <div className="min-w-0">
        <div className="line-clamp-2 text-[15px] leading-snug text-mist">{item.title}</div>
        <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[10px] text-mist-faint">
          {why && <span className="truncate text-jade">{why}</span>}
          {item.source && item.source !== 'seller' && <span>{item.source}</span>}
          {item.stage !== 'new' && <span>{item.stage}</span>}
          {item.activityAt && <span className="ml-auto shrink-0">{age(item.activityAt)}</span>}
        </div>
      </div>
      <DoLink item={item} row showMissing={false} />
    </div>
  );
}
