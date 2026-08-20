// CRM — the business pipeline over what the collectors already know.
//
// The dashboard could SHOW leads (signals) and accounts (tiyuvta) but nothing
// remembered what the owner did about them: no stage, no notes, no "ping them
// Thursday". This module adds exactly that memory and nothing else — the live
// facts (requests, spend, thread titles) keep coming from their collectors, so
// the CRM file never goes stale on data it doesn't own.
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

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { store } from './state.js';
import { iso, readJson } from './util.js';
import type {
  CrmContact,
  CrmEntry,
  CrmItem,
  CrmNote,
  CrmPipeline,
  CrmStage,
  Flag,
  SignalItem,
} from '../../shared/types.js';

/** Runtime twin of the CrmStage union (shared/types.ts is types-only — see the
 *  note there). The two satisfies-checks make drift a compile error both ways. */
export const CRM_STAGES = ['new', 'contacted', 'replied', 'signed-up', 'active', 'paying', 'lost'] as const satisfies readonly CrmStage[];
type _Complete = CrmStage extends (typeof CRM_STAGES)[number] ? true : never;
const _complete: _Complete = true;
void _complete;

let file = join(config.configDir, 'crm.json');
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
  paid: boolean;
  enrolled: boolean;
  suspended: boolean;
  internal?: boolean;
  lastActiveDay?: string | number | null;
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
  return (
    persisted.entries[id] ?? {
      id,
      stage: null,
      notes: [],
      contacts: [],
      followUpAt: null,
      updatedAt: iso(),
    }
  );
}

function cleanText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${field}`);
  return value.trim().slice(0, TEXT_CAP);
}

// --- pipeline assembly -------------------------------------------------------

/** Leads are the actionable signal kinds — a thread or mention is somewhere a
 *  comment can win a user; counters and releases are news, not people. */
const LEAD_KINDS = new Set(['mention', 'demand-thread', 'prospect-thread']);

function derivedLeadStage(signal: SignalItem): CrmStage {
  if (signal.lead?.status === 'engaged') return 'contacted';
  if (signal.lead?.status === 'dismissed') return 'lost';
  return 'new';
}

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

function toItem(
  id: string,
  kind: CrmItem['kind'],
  derivedStage: CrmStage,
  base: Pick<CrmItem, 'title' | 'subtitle' | 'url' | 'metrics' | 'activityAt'>,
  now: string,
): CrmItem {
  const entry = persisted.entries[id];
  const stage = entry?.stage ?? derivedStage;
  const followUpAt = entry?.followUpAt ?? null;
  return {
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
  };
}

function assemble(): CrmPipeline {
  const now = iso();
  const items: CrmItem[] = [];
  const liveIds = new Set<string>();

  for (const signal of store.get().signals.items) {
    if (!LEAD_KINDS.has(signal.kind)) continue;
    liveIds.add(signal.id);
    items.push(
      toItem(signal.id, 'lead', derivedLeadStage(signal), {
        title: signal.title,
        subtitle: [signal.entity, signal.source].filter(Boolean).join(' · ') || null,
        url: signal.url,
        metrics: null,
        activityAt: signal.occurredAt ?? signal.firstSeenAt,
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
        url: null,
        metrics: { requests: account.requests, spentMicro: account.spentMicro, paid: account.paid },
        activityAt: typeof account.lastActiveDay === 'string' ? account.lastActiveDay : null,
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
    items.push(
      toItem(entry.id, entry.id.startsWith('tenant:') ? 'account' : 'lead', 'new', {
        title: entry.id,
        subtitle: 'source item no longer reported',
        url: null,
        metrics: null,
        activityAt: entry.updatedAt,
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
  },

  pipeline(): CrmPipeline {
    return assemble();
  },

  /** Set or clear the manual stage and/or the follow-up date. */
  async update(id: unknown, patch: { stage?: unknown; followUpAt?: unknown }): Promise<CrmEntry> {
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
    entry.updatedAt = iso();
    persisted.entries[id] = entry;
    await persist();
    raiseFollowUpFlags();
    return entry;
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

  /** test hook: reset in-memory state and redirect the persist file */
  _resetForTest(filePath?: string): void {
    persisted = { entries: {} };
    loaded = true;
    if (filePath) file = filePath;
  },
};
