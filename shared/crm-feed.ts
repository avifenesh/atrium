// The activity feed's fold: several rows about one thing, printed as one line.
//
// It lives in shared/ rather than inside the tab that draws it because a folded
// row does arithmetic, and arithmetic that can lose money needs a test: the first
// cut printed `usage x2, <handle>` and threw both members' amounts away, so two
// customers' spend vanished from the only surface that reports it. web/ has no
// test runner and shared/ compiles into the server build, so the rules are pinned
// by server/src/crm-feed.test.ts.
//
// Three folds, in the order a row is offered to them:
//
//  1. SWEEP. A bulk close by the owner is ONE act (86 suspensions carried one
//     identical timestamp), and it folds across identities because the accounts
//     in it share nothing else. Only closing destinations fold this way. A move
//     into `paying` never does: two customers starting to pay four minutes apart
//     are two facts.
//  2. IDENTITY, over the whole day group. One folded mailbox, else one private
//     email domain. Not per consecutive run: any unrelated row between two
//     same-handle rows started a new run, and one throwaway domain printed three
//     times in a day.
//  3. DUPLICATE. Same item, same type, seconds apart. A double-fired do-launch
//     carries no address at all, so neither of the folds above can see it.
//
// A row keeps its own text until something joins it, so a single event always
// prints exactly what the ledger recorded.

import { addressIn, foldMailboxIn, isPublicProvider, mailboxDomain } from './mailbox.js';
import type { CrmEvent } from './types.js';

/** Addresses printed inside one folded row before it says "and N more". */
export const MEMBER_PREVIEW = 3;
/** Rows further apart than this are two acts by the owner, not one sweep. */
const SWEEP_WINDOW_MS = 600_000;
/** Same item, same type, this close together: one thing that fired twice. */
const DUPLICATE_WINDOW_MS = 300_000;
/**
 * Destinations the owner closes in bulk, and the only ones a fold may cross
 * identities for. Every other destination stays one row per account, `paying`
 * above all: a fold that hid a second customer starting to pay would be hiding
 * the one row the feed exists for.
 */
const SWEEP_STAGES = new Set(['lost', 'skipped']);

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

export type FoldKind = 'mailbox' | 'domain' | 'transition' | 'duplicate';

/** Request and spend deltas, as a usage row printed them. */
export interface UsageDelta {
  requests: number;
  spentMicro: number;
}

/** One printed line: a single event, or several that fold onto one claim. */
export interface FeedRow {
  key: string;
  /** the newest event in the run: its timestamp, its type, its drawer target */
  head: CrmEvent;
  count: number;
  /** what a folded row can honestly name: the shared handle, the transition every
   *  member made, or the head's own title when the members share only an id */
  label: string;
  labelKind: FoldKind;
  /** the distinct addresses behind a folded row, newest first */
  members: string[];
  /** the SUM of the deltas the members claimed, so a fold cannot swallow money.
   *  null when the row is not usage, or when a member carried no readable delta,
   *  which is also the signal to refuse the fold rather than to fold a zero. */
  usage: UsageDelta | null;
}

/** The stage a `stage-change` title moved TO. The title is written as
 *  `<subject>: <from> → <to>`, and the arrow cannot occur in a stage name, so the
 *  tail after the last arrow is the destination. */
export function stageMovedTo(title: string): string | null {
  const parts = title.split(' → ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : null;
}

/** The stage it moved FROM. The subject is free text that can hold both a colon
 *  and an arrow (a lead title is a truncated post, and one account title in the
 *  ledger is a whole sentence about Paddle), so this reads the segment before the
 *  LAST arrow and takes the tail after its last `: ` separator. */
export function stageMovedFrom(title: string): string | null {
  const parts = title.split(' → ');
  if (parts.length < 2) return null;
  const before = parts[parts.length - 2];
  const cut = before.lastIndexOf(': ');
  return (cut >= 0 ? before.slice(cut + 2) : before).trim() || null;
}

/**
 * The delta an `account-usage` title claims. Both title shapes read the same
 * way: rows written before the sub-cent rule printed `+$0.00`, rows written after
 * it omit the money clause when it would round to nothing. null means the title
 * is not that shape at all, and a run holding one of those must not fold.
 */
export function usageDelta(title: string): UsageDelta | null {
  const hit = title.match(/\+(\d+) req(?: · \+\$(\d+(?:\.\d+)?))?/u);
  if (!hit) return null;
  return { requests: Number(hit[1]), spentMicro: hit[2] ? Math.round(Number(hit[2]) * 1_000_000) : 0 };
}

/** The address a row is about, or null. Only account rows carry one: an itemId
 *  starting with `tenant:` is the guarantee that the address in the title belongs
 *  to an account and is not a word inside a lead's thread title. */
function addressOf(e: CrmEvent): string | null {
  return e.itemId?.startsWith('tenant:') ? addressIn(e.title) : null;
}

interface Candidate {
  key: string;
  kind: FoldKind;
  label: string;
  /** null = the fold holds for the whole day group */
  windowMs: number | null;
}

interface Run {
  row: FeedRow;
  /** the oldest member so far; the windowed folds measure from it */
  oldestAt: string;
  /** every folded mailbox the members landed in, so a domain run that turns out
   *  to be one person can say so */
  mailboxes: Set<string>;
}

function candidatesFor(e: CrmEvent, mailbox: string | null, domain: string | null): Candidate[] {
  const out: Candidate[] = [];
  const to = e.type === 'stage-change' ? stageMovedTo(e.title) : null;
  if (to && SWEEP_STAGES.has(to)) {
    const from = stageMovedFrom(e.title) ?? '?';
    out.push({
      key: `sweep|${from}|${to}`,
      kind: 'transition',
      label: `${from} → ${to}`,
      windowMs: SWEEP_WINDOW_MS,
    });
  }
  // A public provider is not a handle: two gmail addresses with different local
  // parts are two people, and folding them would hide a real signup. The mailbox
  // fold carries the gmail cases instead.
  if (domain) out.push({ key: `${e.type}|domain|${domain}`, kind: 'domain', label: domain, windowMs: null });
  else if (mailbox) out.push({ key: `${e.type}|mailbox|${mailbox}`, kind: 'mailbox', label: mailbox, windowMs: null });
  if (e.itemId) out.push({ key: `${e.type}|item|${e.itemId}`, kind: 'duplicate', label: e.title, windowMs: DUPLICATE_WINDOW_MS });
  return out;
}

/**
 * Fold one day group, newest first. Row order follows each run's NEWEST member,
 * which is the order the events already arrive in, so the day still reads as a
 * timeline.
 */
export function foldFeedRows(events: CrmEvent[]): FeedRow[] {
  const runs: Run[] = [];
  const byKey = new Map<string, Run>();

  for (const e of events) {
    const address = addressOf(e);
    const mailbox = address ? foldMailboxIn(e.title) : null;
    const rawDomain = address ? mailboxDomain(address) : null;
    const domain = rawDomain && !isPublicProvider(rawDomain) ? rawDomain : null;
    const delta = e.type === 'account-usage' ? usageDelta(e.title) : null;
    const candidates = candidatesFor(e, mailbox, domain);

    let joined: Run | null = null;
    for (const candidate of candidates) {
      const run = byKey.get(candidate.key);
      if (!run) continue;
      if (candidate.windowMs != null && Date.parse(run.oldestAt) - Date.parse(e.at) > candidate.windowMs) continue;
      // A usage run that cannot be added up does not fold: one unreadable member
      // would take every other member's amount with it.
      if (e.type === 'account-usage' && (delta === null || run.row.usage === null)) continue;
      joined = run;
      break;
    }

    if (joined) {
      joined.row.count += 1;
      joined.oldestAt = e.at;
      if (delta && joined.row.usage) {
        joined.row.usage = {
          requests: joined.row.usage.requests + delta.requests,
          spentMicro: joined.row.usage.spentMicro + delta.spentMicro,
        };
      }
      if (address && !joined.row.members.includes(address)) joined.row.members.push(address);
      if (mailbox) joined.mailboxes.add(mailbox);
      continue;
    }

    const first = candidates[0];
    const run: Run = {
      row: {
        key: `${e.at}-${e.type}-${runs.length}`,
        head: e,
        count: 1,
        label: first?.label ?? e.title,
        labelKind: first?.kind ?? 'duplicate',
        members: address ? [address] : [],
        usage: delta,
      },
      oldestAt: e.at,
      mailboxes: mailbox ? new Set([mailbox]) : new Set(),
    };
    runs.push(run);
    for (const candidate of candidates) if (!byKey.has(candidate.key)) byKey.set(candidate.key, run);
  }

  return runs.map(({ row, mailboxes }) => (
    // A domain run whose members all fold to one mailbox is one person, and the
    // mailbox is the stronger claim.
    row.labelKind === 'domain' && mailboxes.size === 1
      ? { ...row, labelKind: 'mailbox' as FoldKind, label: [...mailboxes][0] }
      : row
  ));
}

/** The line a row prints. A folded usage row states the summed delta, because a
 *  count with no amount is where the money went missing. */
export function feedRowTitle(row: FeedRow, typeLabel: string): string {
  if (row.count === 1) return row.head.title;
  const named = row.labelKind === 'mailbox' || row.labelKind === 'domain'
    ? `${row.label} (one ${row.labelKind})`
    : row.label;
  const sum = row.usage
    ? `: +${row.usage.requests} req${row.usage.spentMicro > 0 ? ` · +${money(row.usage.spentMicro)}` : ''}`
    : '';
  return `${typeLabel} x${row.count}, ${named}${sum}`;
}

/** The second line. It lists the distinct ADDRESSES a fold covers and counts the
 *  remainder in addresses too: subtracting a deduped address count from an event
 *  count made four rows about one address claim three more that do not exist. */
export function feedRowDetail(row: FeedRow): string | null {
  if (row.count === 1 || row.members.length <= 1) return row.head.detail;
  const shown = row.members.slice(0, MEMBER_PREVIEW);
  const rest = row.members.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} and ${rest} more` : shown.join(' · ');
}
