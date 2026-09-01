// The users table's fold: one person's several accounts, printed as one row.
//
// The activity feed and the security page already fold one human's accounts into
// one line. The accounts screen was the last place where the owner's own mailbox
// read as six separate customers, so it folds the same way, with the same
// vocabulary (shared/mailbox.ts) rather than a second fold of its own.
//
// It lives in shared/ rather than inside the tab that draws it because a folded
// row does arithmetic, and arithmetic that can lose money needs a test: a group
// row is the ONLY place a member's balance and spend appear while the group is
// collapsed. web/ has no test runner and shared/ compiles into the server build,
// so the rules are pinned by server/src/crm-users.test.ts, exactly as
// shared/crm-feed.ts is pinned by crm-feed.test.ts.
//
// ONE fold only, the mailbox (plus-tag stripped, dots stripped on the providers
// that ignore them). A shared public-provider DOMAIN is not an identity: two
// gmail locals are two people, and grouping them would bury a real customer
// inside a stranger's row. shared/crm-feed.ts refuses that same fold for that
// same reason. A private-domain pile is a real signal but it is a TEAM, not a
// person, so it stays on the security page where it is named as a domain pile.

import { foldMailbox } from './mailbox.js';

/**
 * The account facts the users table reads, adds up and sorts on. A structural
 * subset of `CrmItem['metrics']` rather than that type itself: the fold needs
 * five numbers and a flag, and a test that has to build a whole pipeline item to
 * check a sum is a test nobody writes.
 */
export interface UserMetrics {
  requests: number;
  spentMicro: number;
  /** null = the console reported no credit total, so no balance can be derived */
  balanceMicro: number | null;
  /** null = today's activity report was unavailable; 0 = it was available and
   *  this account made no request today. Different facts. */
  requestsToday: number | null;
  lastActiveDay: string | null;
  paid: boolean;
}

/** What a row has to carry to be folded: an id, an address in its title (account
 *  titles ARE the address), and the numbers a group sums. */
export interface UserRow {
  id: string;
  title: string;
  metrics: UserMetrics | null;
}

export interface UserGroup<T extends UserRow> {
  /** stable across renders and unique per group: the folded mailbox, else the
   *  account's own id */
  key: string;
  /** the folded mailbox, or null when the title is not an address at all */
  mailbox: string | null;
  /** what the folded row names: the mailbox, else the single member's own title */
  label: string;
  members: T[];
  accounts: number;
  /**
   * The members' facts summed, in the same shape a single account carries, so
   * one sort key and one set of cells serve both.
   *
   * A nullable field sums over the members that reported one and stays null only
   * when NO member did: a group holding one unknown balance next to a real $5
   * has to print the $5, because hiding it is how a fold loses money.
   *
   * `lastActiveDay` is the NEWEST day any member has, so one dormant account
   * cannot make a live mailbox look quiet. `paid` is true when ANY member bought.
   */
  totals: UserMetrics;
}

function totalsOf(members: UserRow[]): UserMetrics {
  const totals: UserMetrics = {
    requests: 0,
    spentMicro: 0,
    balanceMicro: null,
    requestsToday: null,
    lastActiveDay: null,
    paid: false,
  };
  for (const member of members) {
    const m = member.metrics;
    if (!m) continue;
    totals.requests += m.requests;
    totals.spentMicro += m.spentMicro;
    if (m.balanceMicro != null) totals.balanceMicro = (totals.balanceMicro ?? 0) + m.balanceMicro;
    if (m.requestsToday != null) totals.requestsToday = (totals.requestsToday ?? 0) + m.requestsToday;
    // A `YYYY-MM-DD` day sorts correctly as a string, so the newest is the largest.
    if (m.lastActiveDay && (totals.lastActiveDay == null || m.lastActiveDay > totals.lastActiveDay)) {
      totals.lastActiveDay = m.lastActiveDay;
    }
    if (m.paid) totals.paid = true;
  }
  return totals;
}

/**
 * Group accounts by the mailbox their addresses fold into, first appearance
 * first. A mailbox nobody shares comes back as a group of ONE, so the caller
 * renders a single code path and a lone account still looks like a plain row.
 */
export function groupUsersByMailbox<T extends UserRow>(rows: T[]): UserGroup<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, { mailbox: string | null; label: string; members: T[] }>();

  for (const row of rows) {
    const mailbox = foldMailbox(row.title);
    // A title the fold cannot read is its own group, keyed by id: two unreadable
    // titles being identical is not evidence that they are one person.
    const key = mailbox ? `mailbox:${mailbox}` : `account:${row.id}`;
    const found = byKey.get(key);
    if (found) {
      found.members.push(row);
      continue;
    }
    byKey.set(key, { mailbox, label: mailbox ?? row.title, members: [row] });
    order.push(key);
  }

  return order.map((key) => {
    const group = byKey.get(key) as { mailbox: string | null; label: string; members: T[] };
    return {
      key,
      mailbox: group.mailbox,
      label: group.label,
      members: group.members,
      accounts: group.members.length,
      totals: totalsOf(group.members),
    };
  });
}
