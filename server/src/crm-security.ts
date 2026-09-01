// Security posture: the abuse-shaped slice of the console dashboard.
//
// Why it is its own module and not a block inside crm-overview.ts: this is the
// one part of the overview that has to be pinned by a test, because it decides
// what the owner is told to look at. It is a pure function of the dashboard
// payload the tiyuvta collector already stores, so it needs no console endpoint
// of its own and no new action name.
//
// It reads the RAW `dashboard.top` rather than the assembled pipeline, following
// signupSources: the pipeline's DashboardAccount narrowing drops createdAt and
// consented, and those are the only signup-timing and consent signals we get.
//
// What can never be here, so nobody goes looking: IP, ASN and user agent. The
// analytics contract forbids collecting them, so the correlators that will ever
// exist are email shape, email domain, signup time, signup ref and usage.

import { foldMailbox, isPublicProvider, mailboxDomain } from '../../shared/mailbox.js';
import type { CrmSecurity, CrmSecurityCluster } from '../../shared/types.js';

/** Two accounts in one mailbox is already the farm shape: the console's fence
 *  allows exactly one, so a second means the fold was evaded or the fence let
 *  something through. */
const MAILBOX_BAR = 2;
/** A private domain needs more than two before it is worth a row: three
 *  colleagues at one company is a normal week, not an attack. */
const DOMAIN_BAR = 3;
/** ...and more still before it counts toward the verdict, so a real team's
 *  domain does not keep the page permanently yellow. */
const DOMAIN_ATTENTION_BAR = 5;
/**
 * A credit balance below this is not a grant. The console writes a one-micro
 * credit when it enrols an account, so "creditedMicro > 0" was true for every
 * account that ever existed and the page reported 86 grants worth $0.00.
 */
const GRANT_FLOOR_MICRO = 10_000;
/** Signups in one UTC hour that make the hour worth naming. Per-hour, not
 *  per-minute: the 86-account farm was paced at a signup every 31 seconds, so no
 *  minute in the whole history ever held more than two. */
const BURST_BAR = 3;
const BURST_WINDOW_DAYS = 14;
const BURST_CAP = 12;
/** Addresses listed inside one cluster row before it says "and N more". */
const MEMBER_CAP = 8;
const CLUSTER_CAP = 24;

interface TopAccount {
  email?: string | null;
  tenantId?: string | null;
  /** epoch ms on the wire; an ISO string is accepted in case that ever changes */
  createdAt?: number | string | null;
  creditedMicro?: number | null;
  spentMicro?: number | null;
  requests?: number | null;
  paid?: boolean;
  suspended?: boolean;
  enrolled?: boolean;
  consented?: boolean;
  internal?: boolean;
}

export interface SecurityDashboard {
  accounts?: {
    total?: number;
    enrolled?: number;
    suspended?: number;
    consented?: number;
    newToday?: number;
    new7d?: number;
  };
  money?: { grantedMicro?: number; pendingPurchases?: number };
  promo?: { claimed?: number; seats?: number; remaining?: number };
  top?: TopAccount[];
}

/**
 * A suspension the verdict has to name: the account had bought, or had spent at
 * least a cent, before it was closed.
 *
 * The bar is money rather than requests on purpose. `suspendedWithTraffic` (any
 * request at all) is 9 accounts today and every one of them is a farm probe with
 * a sub-cent debit, the largest $0.000115. Counting those would leave the page
 * permanently yellow with nothing to do about it, and a verdict that is always
 * yellow is a verdict nobody reads. A suspension carries no timestamp from the
 * console, so this count cannot age out either way: it has to be tight.
 */
function suspendedWithMoney(account: TopAccount): boolean {
  if (account.suspended !== true) return false;
  return account.paid === true || (account.spentMicro ?? 0) >= GRANT_FLOOR_MICRO;
}

function createdMs(account: TopAccount): number | null {
  const raw = account.createdAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function clusterOf(label: string, members: TopAccount[], attentionBar: number): CrmSecurityCluster {
  const stamps = members.map(createdMs).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
  const suspended = members.filter((m) => m.suspended === true).length;
  const open = suspended < members.length;
  return {
    label,
    accounts: members.length,
    suspended,
    granted: members.filter((m) => (m.creditedMicro ?? 0) >= GRANT_FLOOR_MICRO).length,
    grantedMicro: members.reduce((sum, m) => sum + (m.creditedMicro ?? 0), 0),
    requests: members.reduce((sum, m) => sum + (m.requests ?? 0), 0),
    spentMicro: members.reduce((sum, m) => sum + (m.spentMicro ?? 0), 0),
    firstSeen: stamps.length ? new Date(stamps[0]).toISOString() : null,
    lastSeen: stamps.length ? new Date(stamps[stamps.length - 1]).toISOString() : null,
    members: [...members]
      .sort((a, b) => (createdMs(b) ?? 0) - (createdMs(a) ?? 0))
      .slice(0, MEMBER_CAP)
      .map((m) => m.email ?? '?'),
    open,
    wantsLook: open && members.length >= attentionBar,
  };
}

function rank(a: CrmSecurityCluster, b: CrmSecurityCluster): number {
  if (a.open !== b.open) return a.open ? -1 : 1;
  if (b.accounts !== a.accounts) return b.accounts - a.accounts;
  return a.label.localeCompare(b.label);
}

function bursts(accounts: TopAccount[], now: number): CrmSecurity['bursts'] {
  const cutoff = now - BURST_WINDOW_DAYS * 86_400_000;
  const hours = new Map<string, { signups: number; suspended: number }>();
  for (const account of accounts) {
    const ms = createdMs(account);
    if (ms === null || ms < cutoff) continue;
    const hour = new Date(ms).toISOString().slice(0, 13);
    const row = hours.get(hour) ?? { signups: 0, suspended: 0 };
    row.signups += 1;
    if (account.suspended === true) row.suspended += 1;
    hours.set(hour, row);
  }
  return [...hours.entries()]
    .filter(([, row]) => row.signups >= BURST_BAR)
    .map(([hour, row]) => ({ hour, ...row }))
    .sort((a, b) => b.hour.localeCompare(a.hour))
    .slice(0, BURST_CAP);
}

/**
 * The abuse read on the account list. Returns null when the console dashboard
 * has not been collected yet, so the page can say "not read yet" rather than
 * render a wall of confident zeroes.
 */
export function securityPosture(
  dashboard: SecurityDashboard | null | undefined,
  now: number = Date.now(),
): CrmSecurity | null {
  if (!dashboard) return null;
  // Owner-internal accounts are excluded the same way the pipeline excludes
  // them: bench identities share a mailbox on purpose and would be the largest
  // "farm" on the page.
  const external = (dashboard.top ?? []).filter((a) => !a.internal && typeof a.email === 'string' && a.email);

  const byMailbox = new Map<string, TopAccount[]>();
  const byDomain = new Map<string, TopAccount[]>();
  for (const account of external) {
    const email = account.email as string;
    const mailbox = foldMailbox(email);
    if (mailbox) {
      byMailbox.set(mailbox, [...(byMailbox.get(mailbox) ?? []), account]);
    }
    const domain = mailboxDomain(email);
    if (domain && !isPublicProvider(domain)) {
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), account]);
    }
  }

  const mailboxes = [...byMailbox.entries()]
    .filter(([, members]) => members.length >= MAILBOX_BAR)
    .map(([label, members]) => clusterOf(label, members, MAILBOX_BAR))
    .sort(rank)
    .slice(0, CLUSTER_CAP);
  // The domain attention bar is higher than the listing bar on purpose: a three
  // person team should appear on the page without turning the verdict yellow.
  const domains = [...byDomain.entries()]
    .filter(([, members]) => members.length >= DOMAIN_BAR)
    .map(([label, members]) => clusterOf(label, members, DOMAIN_ATTENTION_BAR))
    .sort(rank)
    .slice(0, CLUSTER_CAP);

  const attentionClusters = [...mailboxes, ...domains].filter((c) => c.wantsLook).length;
  const attentionSuspensions = external.filter(suspendedWithMoney).length;

  const promo = dashboard.promo
    ? {
        claimed: dashboard.promo.claimed ?? 0,
        seats: dashboard.promo.seats ?? 0,
        remaining: dashboard.promo.remaining ?? 0,
      }
    : null;

  return {
    mailboxes,
    domains,
    bursts: bursts(external, now),
    promo,
    accounts: {
      total: dashboard.accounts?.total ?? external.length,
      external: external.length,
      enrolled: dashboard.accounts?.enrolled ?? 0,
      consented: dashboard.accounts?.consented ?? 0,
      suspended: dashboard.accounts?.suspended ?? external.filter((a) => a.suspended === true).length,
      newToday: dashboard.accounts?.newToday ?? 0,
      newWeek: dashboard.accounts?.new7d ?? 0,
      neverUsed: external.filter((a) => (a.requests ?? 0) === 0).length,
      suspendedWithTraffic: external.filter((a) => a.suspended === true && (a.requests ?? 0) > 0).length,
      suspendedWithMoney: external.filter(suspendedWithMoney).length,
      ageUnknown: external.filter((a) => createdMs(a) === null).length,
    },
    grantedMicro: dashboard.money?.grantedMicro ?? null,
    pendingPurchases: dashboard.money?.pendingPurchases ?? null,
    // A cluster whose every member is already suspended is history, not work.
    attentionClusters,
    attentionSuspensions,
    attention: attentionClusters + attentionSuspensions,
  };
}
