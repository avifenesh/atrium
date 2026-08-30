// Sticky "do X" on a pipeline card. The agent writes the label; click launches
// a machine-local agent whose prompt is built now, with live product/company
// facts (Hermes council VERIFIED FACTS). Cards that host this cannot stay
// <button> — this is a real button, so the card is a div.

import { useState } from 'react';
import type { CrmItem } from '../../../shared/types';

async function postDo(id: string): Promise<void> {
  const res = await fetch('/api/crm/do', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `do → ${res.status}`);
  }
}

/** No researched first move on this card yet.
 *  The server already strips ingest templates (crm.ts toItem → researchedAction), so
 *  an absent action IS the "needs research" state. This used to keep its own copy of
 *  the template regexes; two lists that only one side tested is how they drift. */
export function isPlaceholderAction(item: CrmItem): boolean {
  return !item.action;
}

function displayLabel(raw: string, compact: boolean): string {
  const text = raw.replace(/^\s*do\s+/iu, '').replace(/\s+/gu, ' ').trim();
  const head = text.split('—')[0]?.trim() || text;
  const shown = compact ? head : text;
  return `Do · ${shown}`;
}

export function DoLink({
  item,
  compact = false,
  showMissing = true,
}: {
  item: CrmItem;
  compact?: boolean;
  showMissing?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');

  if (!item.action) {
    if (!showMissing) return null;
    return (
      <div className={`font-mono text-[10px] text-mist-faint ${compact ? '' : 'mt-1.5'}`}>
        researching a first move
      </div>
    );
  }

  const label =
    state === 'busy'
      ? 'launching…'
      : state === 'ok'
        ? 'launched'
        : state === 'err'
          ? 'launch failed'
          : displayLabel(item.action.label, compact);

  return (
    <button
      type="button"
      draggable={false}
      // 'launched' is terminal: a second launch would kill the session still working
      // on this card (tmux kills a name collision), so the button stops being a button.
      disabled={state === 'busy' || state === 'ok'}
      title={item.action.brief ?? item.action.label}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setState('busy');
        void postDo(item.id)
          .then(() => setState('ok'))
          .catch(() => setState('err'));
      }}
      className={`cursor-pointer text-left font-mono leading-snug ${
        compact
          ? 'mt-1.5 line-clamp-2 text-[11px] underline-offset-2 hover:underline'
          : 'mt-1 w-full rounded-lg border px-3 py-3 text-[15px]'
      } ${
        state === 'ok'
          ? compact ? 'text-jade' : 'border-jade/40 bg-jade/10 text-jade'
          : state === 'err'
            ? compact ? 'text-coral' : 'border-coral/40 bg-coral/10 text-coral'
            : compact ? 'text-amber' : 'border-amber/40 bg-amber/10 text-amber hover:border-amber'
      }`}
    >
      {label}
    </button>
  );
}
