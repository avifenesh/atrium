import type { HelperOffer, HelperPreference } from '../../shared/types.js';

/** `owner/repo#123` — the identity the GitHub collector stamps on every actionable
 *  item, and the identity offer evidence carries for the same piece of work. */
const ITEM_ID = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

export interface OwnerDecisions {
  offers: readonly Pick<HelperOffer, 'status' | 'evidence' | 'key' | 'title'>[];
  preferences: readonly Pick<HelperPreference, 'kind' | 'statement'>[];
}

/** Identities of the items declined offers were *about*. An offer's evidence also
 *  cites supporting items, and declining the offer says nothing about those: the
 *  review packet for valkey-io/valkey#3724 cited #2767 as the linked feature issue,
 *  so an evidence-only match would have silenced an issue the owner never refused.
 *  The number has to appear in the offer's own key or title to count as its subject. */
function declinedItemKeys(offers: OwnerDecisions['offers']): Set<string> {
  const keys = new Set<string>();
  for (const offer of offers) {
    if (offer.status !== 'declined') continue;
    const subjectNumbers = new Set(`${offer.key} ${offer.title}`.match(/\d+/g) ?? []);
    for (const ref of offer.evidence) {
      if (ref.source.trim().toLowerCase() !== 'github') continue;
      const match = ITEM_ID.exec(ref.id.trim());
      if (match && subjectNumbers.has(match[2])) keys.add(`${match[1].toLowerCase()}#${match[2]}`);
    }
  }
  return keys;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An avoid rule silences an item only when its statement names that exact repository
 *  *and* that exact number. Nothing is inferred from a repository or a theme alone:
 *  "…valkey-io/valkey PR #3724" must not silence valkey-io/valkey#2767, and an
 *  "#387-#395" range covers only the two numbers actually written down. */
function avoidsItem(statement: string, repo: string, number: string): boolean {
  const named = new RegExp(`(?<![\\w.-])${escapeRegExp(repo)}(?![\\w.-])`, 'i');
  return named.test(statement) && new RegExp(`#${number}(?!\\d)`).test(statement);
}

/** Split actionable GitHub signals into what the owner still wants to see and what the
 *  owner already refused — a declined offer over the same item, or an avoid rule naming
 *  it. Re-offering refused work is what makes a status surface untrustworthy. */
export function splitOwnerDeclined<T extends { id: string }>(
  items: readonly T[],
  decisions: OwnerDecisions,
): { kept: T[]; declined: T[] } {
  const declinedKeys = declinedItemKeys(decisions.offers);
  const avoidRules = decisions.preferences
    .filter((preference) => preference.kind === 'avoid')
    .map((preference) => preference.statement);
  const kept: T[] = [];
  const declined: T[] = [];
  for (const item of items) {
    const match = ITEM_ID.exec(item.id.trim());
    const refused = match !== null
      && (
        declinedKeys.has(`${match[1].toLowerCase()}#${match[2]}`)
        || avoidRules.some((statement) => avoidsItem(statement, match[1], match[2]))
      );
    (refused ? declined : kept).push(item);
  }
  return { kept, declined };
}
