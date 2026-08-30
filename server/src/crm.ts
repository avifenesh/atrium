// CRM — the business pipeline over what the collectors already know.
//
// The dashboard could SHOW leads (signals) and accounts (tiyuvta) but nothing
// remembered what the owner did about them: no stage, no notes, no "ping them
// Thursday", no stuck next move. This module adds exactly that memory and
// nothing else — the live facts (requests, spend, thread titles) keep coming
// from their collectors, so the CRM file never goes stale on data it doesn't
// own. The do-link's product facts are injected at click (crm-do.ts), not stored.
//
//   ~/.config/atrium/crm.json   { entries: { <id>: CrmEntry } }
//
// Item ids are the sources' own: signal ids for leads, `tenant:<tenantId>` for
// console accounts. An entry whose source item disappeared (signal aged out,
// account deleted) is kept and reported under `orphaned` — owner state is never
// silently dropped.
//
// Follow-ups raise flags through the normal flag pipe, so a due follow-up pings
// the phone like any other crit/warn and shows on every panel with a FlagStrip.

import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { store } from './state.js';
import { scoreLead } from './lead-relevance.js';
import { iso, readJson } from './util.js';
import type {
  CrmAction,
  CrmContact,
  CrmDirection,
  CrmEntry,
  CrmItem,
  CrmNote,
  CrmPipeline,
  CrmStage,
  Flag,
  HelperExecutor,
  SignalItem,
} from '../../shared/types.js';
import { actionFromFirstAction, actionFromOutreachNotes, buildDoPrompt, isPlaceholderAction, loadContextPack, parseAction, writeDoLaunch, type ContextPack } from './crm-do.js';

/** Runtime twin of the CrmStage union (shared/types.ts is types-only — see the
 *  note there). The two satisfies-checks make drift a compile error both ways. */
export const CRM_STAGES = ['new', 'contacted', 'replied', 'signed-up', 'active', 'paying', 'skipped', 'lost'] as const satisfies readonly CrmStage[];
type _Complete = CrmStage extends (typeof CRM_STAGES)[number] ? true : never;
const _complete: _Complete = true;
void _complete;

let file = join(config.configDir, 'crm.json');
let directionsDir = join(config.configDir, 'directions');
const NOTE_CAP = 200;
const CONTACT_CAP = 200;
const TEXT_CAP = 4000;

interface PersistedCrm {
  entries: Record<string, CrmEntry>;
}

/** The slice of the tiyuvta collector's extra payload the pipeline reads. */
interface DashboardAccount {
  email: string;
  tenantId: string;
  requests: number;
  spentMicro: number;
  creditedMicro?: number;
  paid: boolean;
  enrolled: boolean;
  suspended: boolean;
  internal?: boolean;
  lastActiveDay?: string | number | null;
  signupRef?: string | null;
  recent?: Array<{ day: string; requests: number; debitedMicro: number }>;
}

let persisted: PersistedCrm = { entries: {} };
let loaded = false;

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

async function persist(): Promise<void> {
  try {
    await mkdir(config.configDir, { recursive: true });
    await atomicWrite(file, JSON.stringify(persisted, null, 2));
  } catch (err) {
    console.error('[crm] persist failed:', err instanceof Error ? err.message : err);
  }
}

function isStage(value: unknown): value is CrmStage {
  return typeof value === 'string' && (CRM_STAGES as readonly string[]).includes(value);
}

function entryFor(id: string): CrmEntry {
  const existing = persisted.entries[id];
  if (existing) {
    return { ...existing, action: parseAction(existing.action) };
  }
  return {
    id,
    stage: null,
    notes: [],
    contacts: [],
    followUpAt: null,
    action: null,
    updatedAt: iso(),
  };
}

function cleanText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${field}`);
  return value.trim().slice(0, TEXT_CAP);
}

// --- directions ---------------------------------------------------------------
//
// One JSON file per direction under ~/.config/atrium/directions/, written by the
// hermes seller profile's scheduled hunt (and by hand when the owner has an idea).
// Files are the seam on purpose: the hunter needs no atrium API, atrium needs no
// hermes API, and a direction survives either process being down.

let directions: CrmDirection[] = [];

function validDirection(raw: unknown): CrmDirection | null {
  const d = raw as Partial<CrmDirection> | null;
  if (!d || typeof d.slug !== 'string' || !d.slug || typeof d.title !== 'string' || !d.title) return null;
  return {
    slug: d.slug,
    title: d.title.slice(0, 200),
    why: typeof d.why === 'string' ? d.why.slice(0, TEXT_CAP) : '',
    firstAction: typeof d.firstAction === 'string' ? d.firstAction.slice(0, TEXT_CAP) : '',
    segment: typeof d.segment === 'string' ? d.segment.slice(0, 120) : null,
    urls: Array.isArray(d.urls) ? d.urls.filter((u): u is string => typeof u === 'string').slice(0, 8) : [],
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : iso(),
  };
}

async function refreshDirections(): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(directionsDir)).filter((n) => n.endsWith('.json'));
  } catch {
    directions = []; // no dir yet = no directions, not an error
    return;
  }
  const loaded: CrmDirection[] = [];
  for (const name of names) {
    const parsed = validDirection(await readJson<unknown>(join(directionsDir, name)));
    if (parsed) loaded.push(parsed);
  }
  directions = loaded.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// --- pipeline assembly -------------------------------------------------------

/** Leads are the actionable signal kinds — a thread or mention is somewhere a
 *  comment can win a user; counters and releases are news, not people. */
const LEAD_KINDS = new Set(['mention', 'demand-thread', 'prospect-thread']);

function derivedLeadStage(signal: SignalItem): CrmStage {
  if (signal.lead?.status === 'engaged') return 'contacted';
  // dismissed = the seller triaged it away without engaging. That is a skip,
  // not a loss: lost means we tried and it died.
  if (signal.lead?.status === 'dismissed') return 'skipped';
  return 'new';
}

/**
 * Accounts derive their stage from the console, and that derivation is the truth
 * about the *relationship*: a paying account is paying whether or not anyone has
 * written to it. Contacting someone is a thing WE did, not a stage they moved to,
 * so it must never overwrite `active` or `paying` with `contacted` — the first cut
 * did, which moved an account backwards out of `active` into an earlier column the
 * moment it was emailed. Whether a touch happened is already carried by
 * `contacts`, and is reported separately by the outbound funnel.
 */
function derivedAccountStage(account: DashboardAccount): CrmStage {
  if (account.suspended) return 'lost';
  if (account.paid) return 'paying';
  if (account.requests > 1) return 'active';
  return 'signed-up';
}

function accountsFromStore(): DashboardAccount[] {
  const extra = store.get().extra['tiyuvta'];
  const dashboard = (extra?.data as { dashboard?: { top?: DashboardAccount[] } } | undefined)?.dashboard;
  // Owner-internal accounts are not pipeline: bench traffic needs no follow-up.
  return (dashboard?.top ?? []).filter((account) => account.tenantId && !account.internal);
}

function researchedAction(action: CrmAction | null): CrmAction | null {
  return isPlaceholderAction(action) ? null : action;
}

function toItem(
  id: string,
  kind: CrmItem['kind'],
  derivedStage: CrmStage,
  base: Pick<CrmItem, 'title' | 'subtitle' | 'source' | 'detail' | 'url' | 'metrics' | 'activityAt' | 'action'>,
  now: string,
): CrmItem {
  const entry = persisted.entries[id];
  const stage = entry?.stage ?? derivedStage;
  const followUpAt = entry?.followUpAt ?? null;
  const relevance = kind === 'lead'
    ? scoreLead({ kind, title: base.title, subtitle: base.subtitle, detail: base.detail })
    : null;
  return {
    relevance,
    id,
    kind,
    ...base,
    stage,
    derivedStage,
    overridden: entry?.stage != null && entry.stage !== derivedStage,
    followUpAt,
    followUpDue: followUpAt != null && followUpAt <= now,
    notes: entry?.notes ?? [],
    contacts: entry?.contacts ?? [],
    action: researchedAction(parseAction(entry?.action))
      ?? researchedAction(base.action)
      ?? actionFromOutreachNotes(entry?.notes ?? [], base.url),
  };
}

function assemble(): CrmPipeline {
  const now = iso();
  const items: CrmItem[] = [];
  const liveIds = new Set<string>();

  for (const direction of directions) {
    const id = `direction:${direction.slug}`;
    liveIds.add(id);
    items.push(
      toItem(id, 'direction', 'new', {
        title: direction.title,
        subtitle: direction.segment,
        source: 'seller',
        detail: direction.why || null,
        url: direction.urls[0] ?? null,
        metrics: null,
        activityAt: direction.createdAt,
        action: actionFromFirstAction(direction.firstAction, direction.urls[0] ?? null, direction.createdAt),
      }, now),
    );
  }

  for (const signal of store.get().signals.items) {
    if (!LEAD_KINDS.has(signal.kind)) continue;
    // Owner directive 2026-08-23 (extends the no-self-hosting-leads law): HF
    // family-thread hits are downloaders talking about rigs and local runs —
    // not buyers — and stopped qualifying as leads. Threads on OUR OWN cards
    // stay: that author already holds our artifact and is talking to us.
    if (signal.source === 'hf-hub' && !(signal.entity ?? '').startsWith('own card')) continue;
    // A mention is a lead only when it mentions the BUSINESS (tiyuvta, memra).
    // The watch terms also track the owner's OSS projects (agnix, agentsys,
    // valkey...) for the mentions panel — a CI commit naming agnix is not a
    // buyer, and 53 of them buried the real pipeline (owner, 2026-08-23).
    if (signal.kind === 'mention' && !/tiyuvta|memra/iu.test(`${signal.entity ?? ''} ${signal.title}`)) continue;
    liveIds.add(signal.id);
    items.push(
      toItem(signal.id, 'lead', derivedLeadStage(signal), {
        title: signal.title,
        subtitle: signal.entity || null,
        source: signal.source,
        detail: [signal.detail, signal.count != null ? `${signal.count} reactions` : null]
          .filter(Boolean)
          .join(' · ') || null,
        url: signal.url,
        metrics: null,
        activityAt: signal.occurredAt ?? signal.firstSeenAt,
        action: null,
      }, now),
    );
  }

  for (const account of accountsFromStore()) {
    const id = `tenant:${account.tenantId}`;
    liveIds.add(id);
    items.push(
      toItem(id, 'account', derivedAccountStage(account), {
        title: account.email,
        subtitle: `${account.requests} req · $${(account.spentMicro / 1_000_000).toFixed(2)}`,
        source: 'console',
        detail: [
          account.paid ? 'paid' : 'free',
          account.enrolled ? null : 'unenrolled',
          account.signupRef ? `via ${account.signupRef}` : null,
          account.creditedMicro != null
            ? `balance $${((account.creditedMicro - account.spentMicro) / 1_000_000).toFixed(2)}`
            : null,
          typeof account.lastActiveDay === 'string' ? `last active ${account.lastActiveDay}` : null,
          account.recent?.length
            ? `7d: ${account.recent.map((r) => `${r.day.slice(8)}=${r.requests}`).join(' ')}`
            : null,
        ].filter(Boolean).join(' · '),
        url: null,
        metrics: {
          requests: account.requests,
          spentMicro: account.spentMicro,
          paid: account.paid,
          creditedMicro: account.creditedMicro ?? null,
          balanceMicro: account.creditedMicro != null ? account.creditedMicro - account.spentMicro : null,
          enrolled: account.enrolled,
          suspended: account.suspended,
          lastActiveDay: typeof account.lastActiveDay === 'string' ? account.lastActiveDay : null,
          signupRef: account.signupRef ?? null,
        },
        activityAt: typeof account.lastActiveDay === 'string' ? account.lastActiveDay : null,
        action: null,
      }, now),
    );
  }

  // Owner state whose live item vanished: still a pipeline row (the notes and the
  // follow-up are the owner's, not the source's), marked so the UI can say why
  // it carries no live numbers.
  const orphaned: string[] = [];
  for (const entry of Object.values(persisted.entries)) {
    if (liveIds.has(entry.id)) continue;
    orphaned.push(entry.id);
    const kind = entry.id.startsWith('tenant:') ? 'account' : entry.id.startsWith('direction:') ? 'direction' : 'lead';
    // The raw id is a useless header ("x:2089854486..."), and an X status id is
    // still a working link — reconstruct what we can so the owner's notes stay
    // actionable after the source item ages out.
    const statusId = entry.id.match(/^x:(\d+)$/u)?.[1] ?? null;
    const firstNote = entry.notes[0]?.text.replace(/\s+/gu, ' ').trim() ?? null;
    items.push(
      toItem(entry.id, kind, 'new', {
        title: firstNote ? firstNote.slice(0, 120) : statusId ? `X post ${statusId.slice(-6)}` : entry.id,
        subtitle: 'source item no longer reported',
        source: null,
        detail: null,
        url: statusId ? `https://x.com/i/web/status/${statusId}` : null,
        metrics: null,
        activityAt: entry.updatedAt,
        action: researchedAction(parseAction(entry.action))
          ?? actionFromOutreachNotes(entry.notes, statusId ? `https://x.com/i/web/status/${statusId}` : null),
      }, now),
    );
  }

  // Due follow-ups first, then newest activity — the phone screen shows the top.
  items.sort((a, b) => {
    if (a.followUpDue !== b.followUpDue) return a.followUpDue ? -1 : 1;
    return (b.activityAt ?? '').localeCompare(a.activityAt ?? '');
  });

  return { updatedAt: now, stages: CRM_STAGES, items, orphaned };
}

// --- follow-up flags ----------------------------------------------------------

/** An active or paying account that stops calling is churning — worth more
 *  attention than ten new leads. Quiet = no activity for this many days. */
const QUIET_DAYS = 3;

function quietAccountFlags(now: string): Flag[] {
  const today = now.slice(0, 10);
  const flags: Flag[] = [];
  for (const account of accountsFromStore()) {
    const stage = derivedAccountStage(account);
    if (stage !== 'active' && stage !== 'paying') continue;
    const last = typeof account.lastActiveDay === 'string' ? account.lastActiveDay : null;
    if (!last) continue;
    const silentDays = Math.floor((Date.parse(today) - Date.parse(last)) / 86_400_000);
    if (silentDays < QUIET_DAYS) continue;
    // Already chased since they went quiet: the ball is in their court, and a
    // flag that keeps firing after the email was sent trains the owner to
    // ignore the strip. A follow-up date is the right nag for that case.
    const entry = persisted.entries[`tenant:${account.tenantId}`];
    const lastTouch = entry?.contacts.at(-1)?.at ?? null;
    if (lastTouch && lastTouch.slice(0, 10) >= last) continue;
    flags.push({
      id: `crm:quiet:tenant:${account.tenantId}`,
      severity: 'warn',
      title: `customer gone quiet: ${account.email}`,
      detail: `${stage} account, ${account.requests} requests lifetime — last active ${last} (${silentDays}d ago)`,
      source: 'crm',
      raisedAt: now,
    });
  }
  return flags;
}

/** Fresh leads rot: a demand thread answered by someone else stops being a
 *  lead. One AGGREGATE flag (not per lead — the strip is not a lead list). */
const STALE_LEAD_HOURS = 24;

function staleLeadFlag(items: CrmItem[], now: string): Flag[] {
  const cutoff = Date.parse(now) - STALE_LEAD_HOURS * 3_600_000;
  const stale = items.filter(
    (i) => i.kind === 'lead' && i.stage === 'new' && i.activityAt != null && Date.parse(i.activityAt) < cutoff,
  );
  if (stale.length === 0) return [];
  return [{
    id: 'crm:stale-leads',
    severity: 'warn',
    title: `${stale.length} new lead${stale.length === 1 ? '' : 's'} older than ${STALE_LEAD_HOURS}h`,
    detail: `unanswered demand rots — oldest: ${stale[stale.length - 1]?.title.slice(0, 80)}`,
    source: 'crm',
    raisedAt: now,
  }];
}

function raiseFollowUpFlags(): void {
  const now = iso();
  const flags: Flag[] = [];
  for (const entry of Object.values(persisted.entries)) {
    if (entry.followUpAt && entry.followUpAt <= now) {
      flags.push({
        id: `crm:follow-up:${entry.id}`,
        severity: 'warn',
        title: `CRM follow-up due: ${entry.id}`,
        detail: entry.notes.at(-1)?.text ?? 'no note',
        source: 'crm',
        raisedAt: entry.followUpAt,
      });
    }
  }
  flags.push(...quietAccountFlags(now));
  flags.push(...staleLeadFlag(assemble().items, now));
  store.setFlags('crm', flags);
}

export const crm = {
  async load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const saved = await readJson<Partial<PersistedCrm>>(file);
    if (saved?.entries && typeof saved.entries === 'object') {
      persisted = { entries: saved.entries as Record<string, CrmEntry> };
    }
    raiseFollowUpFlags();
    // an hourly re-check turns a future followUpAt into a flag without a write
    setInterval(raiseFollowUpFlags, 3_600_000).unref();
    await refreshDirections();
    // the seller hunt runs every 6h; a 5-minute re-read is generous
    setInterval(() => void refreshDirections(), 300_000).unref();
  },

  pipeline(): CrmPipeline {
    return assemble();
  },

  /** Set or clear the manual stage, the follow-up date, and/or the stuck action. */
  async update(id: unknown, patch: { stage?: unknown; followUpAt?: unknown; action?: unknown }): Promise<CrmEntry> {
    if (typeof id !== 'string' || !id) throw new Error('missing id');
    const entry = entryFor(id);
    if ('stage' in patch) {
      if (patch.stage !== null && !isStage(patch.stage)) throw new Error(`invalid stage: ${String(patch.stage)}`);
      entry.stage = patch.stage;
    }
    if ('followUpAt' in patch) {
      if (patch.followUpAt !== null && (typeof patch.followUpAt !== 'string' || Number.isNaN(Date.parse(patch.followUpAt)))) {
        throw new Error('followUpAt must be an ISO date or null');
      }
      entry.followUpAt = patch.followUpAt as string | null;
    }
    if ('action' in patch) {
      if (patch.action === null) {
        entry.action = null;
      } else {
        const action = parseAction(patch.action, iso());
        if (!action) throw new Error('action.label is required');
        entry.action = action;
      }
    }
    entry.updatedAt = iso();
    persisted.entries[id] = entry;
    await persist();
    raiseFollowUpFlags();
    return entry;
  },

  item(id: string): CrmItem | undefined {
    return assemble().items.find((row) => row.id === id);
  },

  /** Live do-prompt: action + VERIFIED FACTS fetched now, not when the action was written. */
  async doPrompt(id: unknown, pack?: ContextPack): Promise<{ prompt: string; item: CrmItem }> {
    if (typeof id !== 'string' || !id) throw new Error('missing id');
    const item = this.item(id);
    if (!item) throw new Error('unknown item');
    if (!item.action) throw new Error('item has no action');
    const prompt = buildDoPrompt(item, pack ?? await loadContextPack());
    return { prompt, item };
  },

  /** One fixed action: launch the SERVER-BUILT prompt for this card. The request
   *  body chooses the executor and nothing else.
   *
   *  There used to be a `prompt` field that replaced the built prompt verbatim.
   *  POST /api/crm/do is reachable from the public CRM host (crmPathAllowed
   *  admits /api/crm/*), and that prompt becomes the agent's first argv token on
   *  this machine, so the field turned one authenticated request into
   *  "run anything here" — the seam law's path-proxy, with no caller: neither the
   *  board nor the detail sheet ever sent it. Manual runs use the copy-prompt
   *  button and a terminal. */
  async launchDo(id: unknown, input: unknown): Promise<{ launched: true; executor: HelperExecutor; session: string }> {
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const executor: HelperExecutor = raw.executor === 'codex' ? 'codex' : 'claude';
    const built = await this.doPrompt(id);
    const { session } = await writeDoLaunch({
      id: built.item.id,
      title: built.item.title,
      executor,
      prompt: built.prompt,
    });
    return { launched: true, executor, session };
  },

  async refreshDirections(): Promise<number> {
    await refreshDirections();
    return directions.length;
  },

  async addNote(id: unknown, text: unknown): Promise<CrmNote> {
    if (typeof id !== 'string' || !id) throw new Error('missing id');
    const note: CrmNote = { at: iso(), text: cleanText(text, 'note text') };
    const entry = entryFor(id);
    entry.notes = [...entry.notes, note].slice(-NOTE_CAP);
    entry.updatedAt = note.at;
    persisted.entries[id] = entry;
    await persist();
    return note;
  },

  /** Log a touch. On a lead still sitting at 'new', logging a contact IS the
   *  contact, so the stage advances with it. Accounts derive their stage from
   *  the console and never get auto-pinned here. */
  async addContact(id: unknown, channel: unknown, summary: unknown): Promise<CrmContact> {
    if (typeof id !== 'string' || !id) throw new Error('missing id');
    const contact: CrmContact = {
      at: iso(),
      channel: cleanText(channel, 'channel'),
      summary: cleanText(summary, 'summary'),
    };
    const entry = entryFor(id);
    entry.contacts = [...entry.contacts, contact].slice(-CONTACT_CAP);
    if (!id.startsWith('tenant:') && (entry.stage === null || entry.stage === 'new')) entry.stage = 'contacted';
    entry.updatedAt = contact.at;
    persisted.entries[id] = entry;
    await persist();
    return contact;
  },

  /** test hook: re-read the directions dir on demand */
  async _refreshDirectionsForTest(): Promise<void> {
    await refreshDirections();
  },

  /** test hook: reset in-memory state and redirect the persist file / directions dir */
  _resetForTest(filePath?: string, dirPath?: string): void {
    persisted = { entries: {} };
    directions = [];
    loaded = true;
    if (filePath) file = filePath;
    if (dirPath) directionsDir = dirPath;
  },
};
