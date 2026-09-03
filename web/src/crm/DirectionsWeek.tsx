// Three hunts in play. The rest is a parked backlog, not a second kanban.

import { useState } from 'react';
import type { CrmItem } from '../../../shared/types';
import { DoLink } from './Action';
import { age } from './time';

export function DirectionsWeek({
  items,
  onOpen,
}: {
  items: CrmItem[];
  onOpen: (id: string) => void;
}) {
  const ranked = [...items].sort((a, b) => {
    const aDo = a.action ? 0 : 1;
    const bDo = b.action ? 0 : 1;
    if (aDo !== bDo) return aDo - bDo;
    return (b.activityAt ?? '').localeCompare(a.activityAt ?? '');
  });
  const week = ranked.slice(0, 3);
  const later = ranked.slice(3);
  const [showLater, setShowLater] = useState(false);

  if (ranked.length === 0) {
    return <div className="empty-state px-1 py-10 text-sm text-mist-dim">No open hunts.</div>;
  }

  return (
    <div className="space-y-4">
      <Section label="This week" items={week} onOpen={onOpen} />
      {later.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowLater(!showLater)}
            className="mb-2 cursor-pointer font-mono text-[11px] text-mist-faint underline"
          >
            {showLater ? 'Hide later' : `Later ${later.length}`}
          </button>
          {showLater && <Section label="Later" items={later} onOpen={onOpen} />}
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: CrmItem[];
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">{label}</div>
      <div className="panel-surface">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item.id)}
            className="surface-row grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-left sm:px-4"
          >
            <div className="min-w-0">
              <div className="truncate text-[15px] text-mist">{item.title}</div>
              {item.detail && <div className="mt-0.5 line-clamp-2 text-sm text-mist-dim">{item.detail}</div>}
              <div className="mt-1 flex gap-2 font-mono text-[10px] text-mist-faint">
                {item.subtitle && <span className="truncate">{item.subtitle}</span>}
                {item.activityAt && <span className="ml-auto shrink-0">{age(item.activityAt)}</span>}
              </div>
            </div>
            <DoLink item={item} row showMissing={false} />
          </button>
        ))}
      </div>
    </div>
  );
}
