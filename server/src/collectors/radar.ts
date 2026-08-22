// Hugging Face demand radar — a plugin collector.
//
// Watches a HAND-PICKED list of model families and tells you two things about each:
// whether a new checkpoint just landed, and whether anyone is publicly asking for a
// format you could ship. Both are time-critical in the same way: an artifact
// published within hours of a checkpoint is worth a large multiple of the same
// artifact published a week later, and a thread asking for a format is a
// pre-qualified audience that stops being one once someone answers it.
//
// DELIBERATELY NOT A FIREHOSE. It polls only the families in `config.radar.watch` —
// models you serve or would consider serving. Watching every release on the Hub
// produces a wall of things you cannot act on, which is how a radar becomes noise and
// then becomes muted.
//
// Polling rather than webhooks: the Hub can push repo events, but that needs a public
// endpoint and atrium is loopback-only by design. A 15-minute poll is inside the
// window that matters and costs one unauthenticated request per watched item.
//
// Everything here is a public, unauthenticated endpoint. No token, no account.

import { config } from '../config.js';
import { expandHfModels } from '../core/exposure-snapshot.js';
import { signals } from '../signals.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Flag, SignalItem } from '../../../shared/types.js';
import type { Collector } from './registry.js';

const API = 'https://huggingface.co/api';
const HOUR = 3_600_000;

interface WatchEntry {
  /** Display name, e.g. "Qwen3.8 27B". */
  family: string;
  /** Hub org whose new releases matter, e.g. "Qwen". */
  org: string;
  /** Canonical checkpoint, for counting how many derivatives already exist. */
  baseModel?: string;
  /** Name substring that identifies THIS family inside the org, e.g. "gemma-4".
   *  Without it, "newest in org" means newest of anything the org publishes — for
   *  google that was a JAX tabular model, which is true and useless. */
  match?: string;
  /** Repos whose discussion tabs carry the demand — usually the popular mirrors. */
  mirrors?: string[];
  /** Free text: supported / tuning / candidate. Rendered as-is. */
  status?: string;
}

interface RadarConfig {
  watch: WatchEntry[];
  /** our own Hub cards (watch.hfModels) — every open thread there is inbound */
  ownCards: string[];
  demandKeywords: string[];
  prospectKeywords: string[];
  freshHours: number;
  /** A matching thread this popular is worth interrupting for. */
  reactionAlert: number;
  /** Hub username whose comments mean "already engaged" — auto-marks the lead so
   *  answered threads leave the action queue on their own. Unset disables it. */
  selfUser: string | null;
}

function radarConfig(): RadarConfig {
  const raw = (config as unknown as { radar?: Partial<RadarConfig> }).radar ?? {};
  // the watch list and keywords come from the runtime-editable signals watch file,
  // so the UI can change them without a code change or restart; thresholds stay in
  // config.json (they are policy, not portfolio)
  const watch = signals.watch();
  return {
    watch: watch.radarWatch,
    ownCards: watch.hfModels ?? [],
    demandKeywords: watch.demandKeywords.map((k) => k.toLowerCase()),
    prospectKeywords: (watch.prospectKeywords ?? []).map((k) => k.toLowerCase()),
    freshHours: typeof raw.freshHours === 'number' ? raw.freshHours : 48,
    reactionAlert: typeof raw.reactionAlert === 'number' ? raw.reactionAlert : 3,
    selfUser: typeof raw.selfUser === 'string' && raw.selfUser.trim() ? raw.selfUser.trim() : null,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'atrium-radar' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${url.slice(API.length)}`);
  return (await response.json()) as T;
}

interface HubModel {
  id: string;
  createdAt?: string;
  downloads?: number;
  likes?: number;
}

interface HubDiscussion {
  num: number;
  title: string;
  status: string;
  isPullRequest: boolean;
  createdAt: string;
  numComments: number;
  numReactionUsers: number;
}

const ageHours = (when?: string): number | null => {
  if (!when) return null;
  const at = Date.parse(when);
  return Number.isFinite(at) ? (Date.now() - at) / HOUR : null;
};

const shortAge = (hours: number): string =>
  hours < 1 ? `${Math.round(hours * 60)}m ago` : hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;

/** Newest release of a family, and how long ago it landed. Scoped by `match` where
 *  given: a large org ships constantly, and its newest anything is not a signal. */
async function newestRelease(org: string, match?: string): Promise<HubModel | null> {
  const search = match ? `&search=${encodeURIComponent(match)}` : '';
  const models = await getJson<HubModel[]>(
    `${API}/models?author=${encodeURIComponent(org)}${search}&sort=createdAt&direction=-1&limit=5`,
  );
  return models[0] ?? null;
}

/** How many derivatives of this checkpoint already exist — the race counter —
 *  plus the most-downloaded ones, whose discussion tabs are where the family's
 *  demand actually lives (a hand-picked mirror list always lags the ecosystem).
 *  Capped: the exact number stops mattering above a page of results, and the Hub
 *  returns no total count for this query, so paging it would cost requests to
 *  learn nothing new. */
async function derivatives(baseModel: string): Promise<{ count: number; capped: boolean; top: string[] }> {
  const results = await getJson<HubModel[]>(
    `${API}/models?filter=${encodeURIComponent(`base_model:quantized:${baseModel}`)}&limit=100&full=false`,
  );
  const top = [...results]
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    .slice(0, 4)
    .map((m) => m.id);
  return { count: results.length, capped: results.length >= 100, top };
}

/** Open, non-PR threads whose title asks for something we could ship, or shows a
 *  buyer failing to run the model. Prospect keywords win the tie: someone whose
 *  title says "OOM" is a hosted-inference prospect even if it also says "gguf". */
async function matchingThreads(
  repo: string,
  demand: string[],
  prospect: string[],
): Promise<Array<HubDiscussion & { threadKind: 'demand-thread' | 'prospect-thread' }>> {
  const payload = await getJson<{ discussions: HubDiscussion[] }>(`${API}/models/${repo}/discussions?p=0`);
  const out: Array<HubDiscussion & { threadKind: 'demand-thread' | 'prospect-thread' }> = [];
  for (const thread of payload.discussions ?? []) {
    if (thread.isPullRequest || thread.status !== 'open') continue;
    const title = thread.title.toLowerCase();
    if (prospect.some((word) => title.includes(word))) out.push({ ...thread, threadKind: 'prospect-thread' });
    else if (demand.some((word) => title.includes(word))) out.push({ ...thread, threadKind: 'demand-thread' });
  }
  return out;
}

/** True when `user` has already commented in the thread. */
async function selfCommented(repo: string, num: number, user: string): Promise<boolean> {
  const payload = await getJson<{ events?: Array<{ type: string; author?: { name?: string } }> }>(
    `${API}/models/${repo}/discussions/${num}`,
  );
  return (payload.events ?? []).some(
    (e) => e.type === 'comment' && e.author?.name?.toLowerCase() === user.toLowerCase(),
  );
}

/** When each thread was last checked for a self-comment. Checking only NEW
 *  threads missed the normal case — the owner answers a thread hours after the
 *  radar found it — so unanswered threads are RE-checked on a slow clock:
 *  fresh threads never wait long, and the request cost stays bounded. */
const selfCheckAt = new Map<string, number>();
const SELF_RECHECK_MS = 2 * 3_600_000;

function shouldSelfCheck(id: string): boolean {
  const lead = signals.lead(id);
  if (lead?.status === 'engaged' || lead?.status === 'dismissed') return false; // settled
  const last = selfCheckAt.get(id);
  if (last != null && Date.now() - last < SELF_RECHECK_MS) return false;
  selfCheckAt.set(id, Date.now());
  return true;
}

const collector: Collector = {
  name: 'radar',
  intervalMs: 15 * 60_000,

  async run() {
    const settings = radarConfig();

    if (settings.watch.length === 0) {
      // Not an error: an unconfigured radar is the default state of a fresh install.
      await signals.publish('hf-hub', [], null);
      store.setFlags('radar', []);
      return;
    }

    const items: Array<Omit<SignalItem, 'firstSeenAt'>> = [];
    const flags: Flag[] = [];
    const failures: string[] = [];

    for (const entry of settings.watch) {
      let newest: HubModel | null = null;
      let derived: { count: number; capped: boolean; top: string[] } | null = null;
      const threads: Array<HubDiscussion & { repo: string; threadKind: 'demand-thread' | 'prospect-thread' }> = [];

      try {
        newest = await newestRelease(entry.org, entry.match);
      } catch (error) {
        failures.push(`${entry.org}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (entry.baseModel) {
        try {
          derived = await derivatives(entry.baseModel);
        } catch (error) {
          failures.push(`${entry.baseModel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // hand-picked mirrors plus the family's most-downloaded derivative repos —
      // the cards where the ecosystem actually talks, discovered per poll
      const mirrors = [...new Set([...(entry.mirrors ?? []), ...(derived?.top ?? [])])];
      for (const mirror of mirrors) {
        try {
          for (const thread of await matchingThreads(mirror, settings.demandKeywords, settings.prospectKeywords)) {
            threads.push({ ...thread, repo: mirror });
          }
        } catch (error) {
          failures.push(`${mirror}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const age = ageHours(newest?.createdAt);
      const fresh = age !== null && age <= settings.freshHours;
      if (newest) {
        items.push({
          id: `hf-hub:release:${newest.id}`,
          source: 'hf-hub',
          kind: 'release',
          entity: entry.status ? `${entry.family} · ${entry.status}` : entry.family,
          title: `${newest.id.split('/').pop()}${age === null ? '' : ` — ${shortAge(age)}`}`,
          detail: derived
            ? `${derived.count}${derived.capped ? '+' : ''} derivatives exist so far`
            : null,
          url: `https://huggingface.co/${newest.id}`,
          count: derived?.count ?? null,
          delta: null,
          occurredAt: newest.createdAt ?? null,
        });
      }

      // A checkpoint inside the fresh window is the whole point of the radar, so it
      // is the one thing here allowed to reach the phone. Demand threads are rows on
      // the signals view with a NEW marker — they used to be info flags, which buried
      // the flag strip in unactionable noise until the whole source got muted.
      if (fresh && newest && age !== null) {
        flags.push({
          // Keyed on the model, not on the family: a mute should silence THIS release
          // and still fire for the next one.
          id: `radar:release:${newest.id}`,
          severity: age <= 6 ? 'crit' : 'warn',
          title: `${entry.org} released ${newest.id.split('/').pop()}`,
          detail: `published ${shortAge(age)}${
             derived ? ` — ${derived.count} derivative${derived.count === 1 ? '' : 's'} exist so far` : ''
          }. https://huggingface.co/${newest.id}`,
          source: 'radar',
          raisedAt: iso(),
        });
      }

      for (const thread of threads.sort((a, b) => b.numReactionUsers - a.numReactionUsers)) {
        const id = `hf-hub:thread:${thread.repo}#${thread.num}`;
        // Self-comment detection: a thread the owner already answered is engaged, not
        // an action item. Checked once per untouched thread (existing lead = skip),
        // so the extra request cost is bounded to genuinely new matches.
        if (settings.selfUser && shouldSelfCheck(id)) {
          try {
            if (await selfCommented(thread.repo, thread.num, settings.selfUser)) {
              await signals.setLead(id, 'engaged', `auto: ${settings.selfUser} commented`);
            }
          } catch (error) {
            failures.push(`${thread.repo}#${thread.num}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        items.push({
          id,
          source: 'hf-hub',
          kind: thread.threadKind,
          entity: entry.family,
          title: thread.title.slice(0, 120),
          detail: `${thread.repo.split('/').pop()} #${thread.num} · ${thread.numComments} comments`,
          url: `https://huggingface.co/${thread.repo}/discussions/${thread.num}`,
          count: thread.numReactionUsers,
          delta: null,
          occurredAt: thread.createdAt ?? null,
        });
      }
    }

    // Our own model cards: EVERY open thread is inbound — the author already
    // holds our artifact. Keyword matches keep their demand/prospect kind; the
    // rest surface as 'mention' so no question on our own cards goes unseen.
    // `Author/*` entries expand to the whole account here, same as exposure —
    // a thread on a card the watch list forgot is still a customer talking.
    const ownCards = await expandHfModels(settings.ownCards).catch(() => settings.ownCards);
    for (const own of ownCards) {
      try {
        const payload = await getJson<{ discussions: HubDiscussion[] }>(`${API}/models/${own}/discussions?p=0`);
        for (const thread of payload.discussions ?? []) {
          if (thread.isPullRequest || thread.status !== 'open') continue;
          const title = thread.title.toLowerCase();
          const kind = settings.prospectKeywords.some((w) => title.includes(w))
            ? ('prospect-thread' as const)
            : settings.demandKeywords.some((w) => title.includes(w))
              ? ('demand-thread' as const)
              : ('mention' as const);
          const id = `hf-hub:thread:${own}#${thread.num}`;
          if (settings.selfUser && shouldSelfCheck(id)) {
            try {
              if (await selfCommented(own, thread.num, settings.selfUser)) {
                await signals.setLead(id, 'engaged', `auto: ${settings.selfUser} commented`);
              }
            } catch (error) {
              failures.push(`${own}#${thread.num}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          items.push({
            id,
            source: 'hf-hub',
            kind,
            entity: `own card · ${own.split('/').pop()}`,
            title: thread.title.slice(0, 120),
            detail: `${own.split('/').pop()} #${thread.num} · ${thread.numComments} comments`,
            url: `https://huggingface.co/${own}/discussions/${thread.num}`,
            count: thread.numReactionUsers,
            delta: null,
            occurredAt: thread.createdAt ?? null,
          });
        }
      } catch (error) {
        failures.push(`${own}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Partial data is still useful, so one dead endpoint does not drop the section;
    // the failure list rides along and the rest of the items stand.
    await signals.publish('hf-hub', items, failures.length ? failures.slice(0, 3).join(' | ') : null);
    store.setFlags('radar', flags);
  },
};

export default collector;
