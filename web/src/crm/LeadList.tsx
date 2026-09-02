// Ranked send queue. A kanban with eight empty columns is the wrong shape when
// every open lead sits in new: this is a list you work from the top.

import { useState } from 'react';
import type { CrmItem } from '../../../shared/types';
import { canCommentLink, CommentLink, DoLink, isOpportunity } from './Action';
import { leadFit, leadHeadline } from './leadFace';
import { age } from './time';

export function LeadList({
  items,
  selectedId,
  onSelect,
  onOpen,
  onTouched,
}: {
  items: CrmItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onOpen: (id: string) => void;
  onTouched?: () => void;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  const touched = (result: 'ok' | 'err' = 'ok') => {
    setFlash(result === 'ok'
      ? 'Link copied. Paste on the tweet. Marked commented.'
      : 'Thread is open. Copy https://inference.tiyuvta.ai if the clipboard is locked.');
    onTouched?.();
  };

  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      {flash && <div className="mb-2 text-sm text-jade">{flash}</div>}
      <div className="panel-surface">
        {items.map((item) => (
          <LeadRow
            key={item.id}
            item={item}
            selected={selectedId === item.id}
            onSelect={() => onSelect?.(item.id)}
            onOpen={() => onOpen(item.id)}
            onTouched={touched}
          />
        ))}
      </div>
    </div>
  );
}

export function EmptySend({
  lastCommentAt,
  payingCount,
}: {
  lastCommentAt: string | null;
  payingCount: number;
}) {
  return (
    <div className="empty-state px-1 py-10">
      <div className="text-sm text-mist">Queue is clear.</div>
      <div className="mt-2 text-sm text-mist-dim">
        {lastCommentAt ? `Last comment ${age(lastCommentAt)} ago.` : 'No comments logged yet.'}
        {' '}
        Next hunt is the two-hour X scan.
        {payingCount > 0 ? ` ${payingCount} paying customer${payingCount === 1 ? '' : 's'} on the strip above.` : ''}
      </div>
    </div>
  );
}

export function PayingStrip({
  accounts,
  onOpen,
}: {
  accounts: CrmItem[];
  onOpen: (id: string) => void;
}) {
  if (accounts.length === 0) return null;
  return (
    <div className="mb-5">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-mist-faint">Paying</div>
      <div className="panel-surface">
        {accounts.map((item) => {
          const last = item.contacts[item.contacts.length - 1]?.at ?? item.followUpAt ?? item.activityAt;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.id)}
              className="surface-row flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left sm:px-4"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-mist">{item.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-mist-faint">
                {last ? `last touch ${age(last)} ago` : 'no touch logged'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LeadRow({
  item,
  selected,
  onSelect,
  onOpen,
  onTouched,
}: {
  item: CrmItem;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onTouched?: (result: 'ok' | 'err') => void;
}) {
  const opportunity = isOpportunity(item);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        onSelect();
        onOpen();
      }}
      onFocus={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`surface-row grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber sm:px-4 ${
        selected ? 'bg-white/[0.04]' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-[15px] leading-snug text-mist">{leadHeadline(item)}</div>
        <div className="mt-0.5 line-clamp-1 text-sm text-mist-dim">{item.title}</div>
        <div className="mt-1 text-xs text-mist-dim">{leadFit(item)}</div>
        <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[10px] text-mist-faint">
          {opportunity && <span className="text-amber">opportunity</span>}
          {item.source && item.source !== 'seller' && <span>{item.source}</span>}
          {item.stage !== 'new' && <span>{item.stage}</span>}
          {item.activityAt && <span className="ml-auto shrink-0">{age(item.activityAt)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {canCommentLink(item) && <CommentLink item={item} row onDone={onTouched} />}
        {opportunity && <DoLink item={item} row showMissing={false} />}
      </div>
    </div>
  );
}
