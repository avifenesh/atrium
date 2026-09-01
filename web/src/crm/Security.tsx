// Security tab — the abuse-shaped material, off the motion feed.
//
// It used to live nowhere and everywhere: a farm of plus-tagged signups arrived
// as ninety-odd rows in the activity feed, the suspended accounts it produced sat
// collapsed at the bottom of the users screen, and the promo seat count that
// proves the fence held was fetched but never displayed. This page collects those
// into the shape the question actually has: which accounts are one person, how
// fast did they arrive, what credit did they take, and is any of it still open.
//
// READ-ONLY DISPLAY, same posture as the serving block on the health tab. It
// names shapes and counts and opens the existing account drawer; every
// account-scoped move (suspend, restore, enroll, grant) stays behind the fixed
// action allowlist where it already is. There is deliberately no tenant-id box:
// a field that suspends whichever id is typed into it is a worse surface than a
// documented curl.
//
// The header verdict exists so the page can be IGNORED. "clear" means every
// cluster it found is already dealt with.

import type { CrmItem, CrmOverview, CrmSecurityCluster } from '../../../shared/types';

const money = (micro: number | null | undefined): string =>
  micro == null ? '—' : `$${(micro / 1_000_000).toFixed(2)}`;

/** `2026-08-31T11:05:12Z` reads as `08-31 11:05Z`: the date and the hour are the
 *  whole signal, and the seconds made every column wrap on a phone. */
const stamp = (iso: string | null): string => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z` : '—');

/**
 * Which sentinel incidents are security-shaped rather than infrastructure.
 *
 * The serving alert ledger atrium tails is infra today (edge-down, ssh-down,
 * capture, restart-spike). Three families would matter here if they ever fire:
 * metering failing means requests served unbilled, admission or shed counts are
 * abuse-adjacent, and anything naming a key or an auth failure is credential
 * shaped. Written against `kind` so a new abuse alert on the darklanes side
 * appears here with no atrium change.
 *
 * It matches the kind's FIRST segment only. Matching the whole string made
 * `version:v0.121.0-dle4edfef-admission` a security incident, which is how a
 * page built to be quiet grew five rows about a deploy.
 */
const SECURITY_KIND = /^(auth|abuse|key|credential|metering|admission|shed|suspend|edge-quarantine)/u;
const isSecurityShaped = (kind: string): boolean => SECURITY_KIND.test(kind.split(':')[0]);

function Stat({ label, value, sub, tone = 'text-mist' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/8 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wide text-mist-faint">{label}</div>
      <div className={`font-mono text-sm ${tone}`}>{value}</div>
      {sub && <div className="font-mono text-[10px] text-mist-faint">{sub}</div>}
    </div>
  );
}

function ClusterTable({
  title,
  hint,
  rows,
  handle,
}: {
  title: string;
  hint: string;
  rows: CrmSecurityCluster[];
  handle: string;
}) {
  return (
    <div className="mt-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">{title}</div>
      <div className="mt-0.5 text-xs text-mist-dim">{hint}</div>
      {rows.length === 0 ? (
        <div className="mt-2 rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
          none over the bar
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-xl border border-white/8">
          <table className="w-full border-collapse font-mono text-[12px]">
            <thead>
              <tr className="border-b border-white/8 text-left text-mist-faint">
                <th className="px-3 py-2 font-normal">{handle}</th>
                <th className="px-3 py-2 text-right font-normal">accounts</th>
                <th className="px-3 py-2 text-right font-normal">granted</th>
                <th className="px-3 py-2 text-right font-normal">suspended</th>
                <th className="px-3 py-2 text-right font-normal">used</th>
                <th className="px-3 py-2 text-right font-normal">first seen</th>
                <th className="px-3 py-2 text-right font-normal">last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.label} className="border-b border-white/5 align-top last:border-0">
                  <td className="max-w-[30ch] px-3 py-2" title={c.members.join(' ')}>
                    <div className={`truncate ${c.wantsLook ? 'text-amber' : 'text-mist-dim'}`}>{c.label}</div>
                    <div className="truncate text-[10px] text-mist-faint">
                      {c.members.slice(0, 3).join(' · ')}
                      {c.accounts > 3 ? ` and ${c.accounts - 3} more` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-mist">{c.accounts}</td>
                  <td className="px-3 py-2 text-right text-mist-dim">
                    {c.granted} · {money(c.grantedMicro)}
                  </td>
                  <td className={`px-3 py-2 text-right ${c.wantsLook ? 'text-amber' : c.open ? 'text-mist-dim' : 'text-jade'}`}>
                    {c.suspended} of {c.accounts}
                  </td>
                  <td className="px-3 py-2 text-right text-mist-dim">
                    {c.requests} req · {money(c.spentMicro)}
                  </td>
                  <td className="px-3 py-2 text-right text-mist-faint">{stamp(c.firstSeen)}</td>
                  <td className="px-3 py-2 text-right text-mist-faint">{stamp(c.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SecurityTab({
  data,
  items,
  onOpen,
}: {
  data: CrmOverview;
  items: CrmItem[];
  onOpen: (id: string) => void;
}) {
  const sec = data.security;
  // Open only. A resolved metering alarm is history, and a page whose job is to
  // be ignorable cannot lead with five cleared rows.
  const shaped = (data.serving?.incidents ?? []).filter((i) => isSecurityShaped(i.kind));
  const incidents = shaped.filter((i) => i.open);
  const cleared = shaped.length - incidents.length;
  /* The suspended list MOVED here from the users screen, where it sat collapsed
   * under the working set (owner ask 2026-08-31: "hide the suspended, that
   * bothers me"). It is the same rows and the same drawer, on the page whose
   * subject they are. The users screen keeps a count chip that links here. */
  const suspended = items.filter((i) => i.kind === 'account' && i.metrics?.suspended);

  if (!sec) {
    return (
      <div className="rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
        the console dashboard has not been read yet, so there is no account list to fold
      </div>
    );
  }

  const clear = sec.attention === 0;

  return (
    <div>
      <div className={`rounded-xl border px-3.5 py-3 ${clear ? 'border-jade/30 bg-ink-2' : 'border-amber/40 bg-ink-2'}`}>
        <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">verdict</div>
        <div className={`mt-1 font-display text-xl ${clear ? 'text-jade' : 'text-amber'}`}>
          {clear
            ? 'clear'
            : `${sec.attention} ${sec.attention === 1 ? 'cluster wants' : 'clusters want'} a look`}
        </div>
        <div className="mt-1 text-xs text-mist-dim">
          {sec.accounts.external} external accounts scanned · {sec.mailboxes.length} shared{' '}
          {sec.mailboxes.length === 1 ? 'mailbox' : 'mailboxes'} · {sec.domains.length} domain{' '}
          {sec.domains.length === 1 ? 'pile' : 'piles'} · {sec.bursts.length} burst{' '}
          {sec.bursts.length === 1 ? 'hour' : 'hours'}
          {sec.accounts.ageUnknown > 0 && ` · ${sec.accounts.ageUnknown} without a signup time`}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="promo seats"
          value={sec.promo ? `${sec.promo.claimed} of ${sec.promo.seats}` : '—'}
          sub={sec.promo ? `${sec.promo.remaining} remaining` : 'not reported'}
        />
        <Stat label="new today" value={String(sec.accounts.newToday)} sub={`${sec.accounts.newWeek} in 7d`} />
        <Stat
          label="credit granted"
          value={money(sec.grantedMicro)}
          sub="lifetime, every account"
        />
        <Stat
          label="suspended"
          value={`${sec.accounts.suspended} of ${sec.accounts.total}`}
          sub={
            sec.accounts.suspendedWithTraffic > 0
              ? `${sec.accounts.suspendedWithTraffic} had already served traffic`
              : 'none served traffic first'
          }
          tone={sec.accounts.suspendedWithTraffic > 0 ? 'text-amber' : 'text-mist'}
        />
        <Stat
          label="never used it"
          value={`${sec.accounts.neverUsed} of ${sec.accounts.external}`}
          sub="signed up, never called"
        />
        <Stat label="enrolled" value={String(sec.accounts.enrolled)} sub="metered on the engines" />
        <Stat label="consented" value={String(sec.accounts.consented)} sub="marketing consent given" />
        <Stat
          label="purchases pending"
          value={sec.pendingPurchases == null ? '—' : String(sec.pendingPurchases)}
          sub="checkout started, no money yet"
        />
      </div>

      <ClusterTable
        title="shared mailboxes"
        hint="one mailbox wearing several accounts, after stripping a plus tag and gmail dots. The console's fence allows one, so two is the farm shape."
        rows={sec.mailboxes}
        handle="folded mailbox"
      />

      <ClusterTable
        title="domain piles"
        hint="several accounts on one private domain, which no plus-tag fold can see. Public providers are excluded (a gmail cluster means nothing), and a small pile is often just a team."
        rows={sec.domains}
        handle="domain"
      />

      <div className="mt-4">
        <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">signup bursts</div>
        <div className="mt-0.5 text-xs text-mist-dim">
          UTC hours that took three or more signups, last 14 days. Per hour, not per minute: the
          August farm was paced at a signup every 31 seconds, so no minute ever held three.
        </div>
        {sec.bursts.length === 0 ? (
          <div className="mt-2 rounded-xl border border-white/8 px-3 py-6 text-center font-mono text-xs text-mist-faint">
            no burst hours
          </div>
        ) : (
          <div className="mt-2 space-y-1">
            {sec.bursts.map((b) => (
              <div key={b.hour} className="flex items-baseline gap-3 rounded-lg border border-white/8 px-3 py-1.5">
                <span className="font-mono text-[12px] text-mist">{b.hour.replace('T', ' ')}:00Z</span>
                <span className="font-mono text-[12px] text-amber">{b.signups} signups</span>
                <span className="ml-auto font-mono text-[11px] text-mist-faint">
                  {b.suspended} since suspended
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">sentinel alerts</div>
        {incidents.length === 0 ? (
          <div className="mt-2 rounded-xl border border-white/8 px-3 py-3 font-mono text-[11px] text-mist-faint">
            nothing open
            {cleared > 0 && ` (${cleared} cleared in the window)`}. Mostly not measured here: the
            serving sentinel's stream is infrastructure (edge, ssh, capture, restarts, deploys). Only
            the metering and admission families are abuse-adjacent, and nothing in it names an
            account, a key, or an auth failure, so an abuse alert has to be added on the darklanes
            side before it can appear.
          </div>
        ) : (
          <div className="mt-2 space-y-1">
            {incidents.map((i) => (
              <div key={i.key} className="rounded-lg border border-white/8 px-3 py-1.5">
                <div className="flex items-baseline gap-2">
                  <span className={`font-mono text-[10px] ${i.open ? 'text-coral' : 'text-jade'}`}>
                    {i.open ? 'open' : 'cleared'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-mist">{i.title}</span>
                  <span className="font-mono text-[10px] text-mist-faint">{stamp(i.lastAt)}</span>
                </div>
                <div className="truncate text-[11px] text-mist-dim">{i.detail}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {suspended.length > 0 && (
        <details className="mt-4 rounded-xl border border-white/8 px-3 py-2">
          <summary className="cursor-pointer font-mono text-[11px] text-mist-faint">
            suspended accounts · {suspended.length}
          </summary>
          <div className="mt-2 space-y-1">
            {suspended.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item.id)}
                className="flex w-full cursor-pointer items-baseline gap-3 rounded-lg px-2 py-1 text-left hover:bg-white/[0.03]"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-mist-dim">{item.title}</span>
                <span className="font-mono text-[11px] text-coral">suspended</span>
                <span className="font-mono text-[11px] text-mist-faint">
                  {item.metrics!.requests} req · {money(item.metrics!.spentMicro)}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}

      <div className="mt-4 rounded-xl border border-white/8 px-3.5 py-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-mist-faint">not measured here</div>
        <div className="mt-1 space-y-1 text-xs text-mist-dim">
          <p>
            Owed by the console, and not derivable from anything it sends today: a suspension
            timestamp and reason or actor (suspended is a bare boolean, so these rows cannot be
            ordered or audited), the signups the email fence REJECTED (the only proof it is still
            holding rather than idle), per-key inventory with mint and revoke times, auth-failure
            counts by key, per-tenant admission and shed counts, payment-side abuse signals
            (disputes, refunds, repeated card failures behind a pending purchase), and promo claim
            attempts as distinct from grants.
          </p>
          <p>
            Not computed here either: near-duplicate local parts. A one-letter variant of a known
            address is a farm and no plus-tag or dot fold groups it.
          </p>
          <p>
            Never available, by our own rule: IP, ASN and user agent. The analytics contract forbids
            collecting them, so email shape, email domain, signup time, signup ref and usage are the
            only correlators this page will ever have.
          </p>
        </div>
      </div>
    </div>
  );
}
