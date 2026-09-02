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

/** Draft is sitting. Nobody has logged a send. That is the work on the lead board. */
export function awaitingYou(item: CrmItem): boolean {
  if (item.kind !== 'lead' || !item.action) return false;
  if (item.contacts.length > 0) return false;
  if (item.stage === 'lost' || item.stage === 'skipped') return false;
  return true;
}

export function RelevanceBits({ item }: { item: CrmItem }) {
  if (!item.relevance) return null;
  return (
    <span
      className={item.relevance.qualified ? 'text-jade' : 'text-mist-faint'}
      title={item.relevance.labels.join(', ')}
    >
      score {item.relevance.score}
      {item.relevance.labels[0] ? ` · ${item.relevance.labels[0]}` : ''}
    </span>
  );
}

function bankedDraft(item: CrmItem): string | null {
  for (const note of item.notes) {
    const match = note.text.match(/^outreach draft \(seller\):\s*/iu);
    if (match) return note.text.slice(match[0].length).trim();
  }
  return item.action?.brief?.trim() || null;
}

function isBankedSend(item: CrmItem): boolean {
  return item.kind === 'lead' && !!item.action?.href && !!bankedDraft(item);
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
  row = false,
  showMissing = true,
}: {
  item: CrmItem;
  compact?: boolean;
  row?: boolean;
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

  const banked = isBankedSend(item);
  const idleLabel = banked
    ? row
      ? 'Send'
      : `Send · ${displayLabel(item.action.label, compact).replace(/^Do · /u, '')}`
    : row
      ? 'Do'
      : displayLabel(item.action.label, compact);
  const label = banked
    ? state === 'ok'
      ? row ? 'Copied' : 'copied, tweet open'
      : state === 'err'
        ? row ? 'Opened' : 'copy failed, tweet open'
        : state === 'busy'
          ? 'opening…'
          : idleLabel
    : state === 'busy'
      ? 'launching…'
      : state === 'ok'
        ? 'launched'
        : state === 'err'
          ? 'launch failed'
          : idleLabel;

  return (
    <button
      type="button"
      draggable={false}
      // Agent launch is terminal (tmux name collision). A banked send can be
      // copied again if the first paste missed.
      disabled={state === 'busy' || (!banked && state === 'ok')}
      title={item.action.brief ?? item.action.label}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setState('busy');
        if (banked) {
          const href = item.action!.href!;
          const draft = bankedDraft(item);
          const open = () => window.open(href, '_blank', 'noopener');
          const copy = navigator.clipboard?.writeText
            ? navigator.clipboard.writeText(draft ?? '')
            : Promise.reject(new Error('no clipboard'));
          void copy
            .then(() => {
              open();
              setState('ok');
            })
            .catch(() => {
              open();
              setState('err');
            });
          return;
        }
        void postDo(item.id)
          .then(() => setState('ok'))
          .catch(() => setState('err'));
      }}
      className={`cursor-pointer text-left font-mono leading-snug ${
        row
          ? 'shrink-0 rounded-md border px-2.5 py-1.5 text-[11px]'
          : compact
            ? 'mt-1.5 line-clamp-2 text-[11px] underline-offset-2 hover:underline'
            : 'mt-1 w-full rounded-lg border px-3 py-3 text-[15px]'
      } ${
        state === 'ok'
          ? row || !compact
            ? 'border-jade/40 bg-jade/10 text-jade'
            : 'text-jade'
          : state === 'err'
            ? row || !compact
              ? 'border-coral/40 bg-coral/10 text-coral'
              : 'text-coral'
            : row || !compact
              ? 'border-amber/35 bg-amber/10 text-amber hover:border-amber'
              : 'text-amber'
      }`}
    >
      {label}
    </button>
  );
}
