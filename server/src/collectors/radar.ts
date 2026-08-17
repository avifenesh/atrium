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
import { store } from '../state.js';
import { iso } from '../util.js';
import type { ExtraRow, Flag } from '../../../shared/types.js';
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
  demandKeywords: string[];
  freshHours: number;
  /** A matching thread this popular is worth interrupting for. */
  reactionAlert: number;
}

function radarConfig(): RadarConfig {
  const raw = (config as unknown as { radar?: Partial<RadarConfig> }).radar ?? {};
  return {
    watch: Array.isArray(raw.watch) ? raw.watch : [],
    demandKeywords: Array.isArray(raw.demandKeywords) && raw.demandKeywords.length
      ? raw.demandKeywords.map((k) => k.toLowerCase())
      : ['gguf', 'nvfp4', 'fp8', 'quant', 'mtp', 'speculative', 'draft', 'blackwell', '5090'],
    freshHours: typeof raw.freshHours === 'number' ? raw.freshHours : 48,
    reactionAlert: typeof raw.reactionAlert === 'number' ? raw.reactionAlert : 3,
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

/** How many derivatives of this checkpoint already exist — the race counter.
 *  Capped: the exact number stops mattering above a page of results, and the Hub
 *  returns no total count for this query, so paging it would cost requests to learn
 *  nothing new. */
async function derivativeCount(baseModel: string): Promise<{ count: number; capped: boolean }> {
  const results = await getJson<HubModel[]>(
    `${API}/models?filter=${encodeURIComponent(`base_model:quantized:${baseModel}`)}&limit=100&full=false`,
  );
  return { count: results.length, capped: results.length >= 100 };
}

/** Open, non-PR threads whose title asks for something we could ship. */
async function demandThreads(repo: string, keywords: string[]): Promise<HubDiscussion[]> {
  const payload = await getJson<{ discussions: HubDiscussion[] }>(`${API}/models/${repo}/discussions?p=0`);
  return (payload.discussions ?? []).filter(
    (thread) =>
      !thread.isPullRequest &&
      thread.status === 'open' &&
      keywords.some((word) => thread.title.toLowerCase().includes(word)),
  );
}

const collector: Collector = {
  name: 'radar',
  intervalMs: 15 * 60_000,

  async run() {
    const settings = radarConfig();

    if (settings.watch.length === 0) {
      // Not an error: an unconfigured radar is the default state of a fresh install.
      store.setExtra('radar', {
        title: 'radar',
        updatedAt: iso(),
        up: true,
        rows: [{ label: 'watchlist', value: 'empty — set radar.watch in config.json', tone: 'warn' }],
        error: null,
      });
      store.setFlags('radar', []);
      return;
    }

    const rows: ExtraRow[] = [];
    const flags: Flag[] = [];
    const raw: unknown[] = [];
    const failures: string[] = [];

    for (const entry of settings.watch) {
      const label = entry.status ? `${entry.family} · ${entry.status}` : entry.family;

      let newest: HubModel | null = null;
      let derivatives: { count: number; capped: boolean } | null = null;
      const threads: Array<HubDiscussion & { repo: string }> = [];

      try {
        newest = await newestRelease(entry.org, entry.match);
      } catch (error) {
        failures.push(`${entry.org}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (entry.baseModel) {
        try {
          derivatives = await derivativeCount(entry.baseModel);
        } catch (error) {
          failures.push(`${entry.baseModel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const mirror of entry.mirrors ?? []) {
        try {
          for (const thread of await demandThreads(mirror, settings.demandKeywords)) {
            threads.push({ ...thread, repo: mirror });
          }
        } catch (error) {
          failures.push(`${mirror}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const age = ageHours(newest?.createdAt);
      const fresh = age !== null && age <= settings.freshHours;
      rows.push({
        label,
        value: newest
          ? `${newest.id.split('/').pop()} ${age === null ? '' : shortAge(age)}${
              derivatives ? ` · ${derivatives.count}${derivatives.capped ? '+' : ''} derivatives` : ''
            }`
          : 'no release data',
        tone: fresh ? 'err' : derivatives && derivatives.count === 0 ? 'ok' : undefined,
        href: newest ? `https://huggingface.co/${newest.id}` : undefined,
      });

      // A checkpoint inside the fresh window is the whole point of the radar, so it
      // is the one thing here allowed to reach the phone.
      if (fresh && newest && age !== null) {
        flags.push({
          // Keyed on the model, not on the family: a mute should silence THIS release
          // and still fire for the next one.
          id: `radar:release:${newest.id}`,
          severity: age <= 6 ? 'crit' : 'warn',
          title: `${entry.org} released ${newest.id.split('/').pop()}`,
          detail: `published ${shortAge(age)}${
            derivatives ? ` — ${derivatives.count} derivative${derivatives.count === 1 ? '' : 's'} exist so far` : ''
          }. https://huggingface.co/${newest.id}`,
          source: 'radar',
          raisedAt: iso(),
        });
      }

      for (const thread of threads.sort((a, b) => b.numReactionUsers - a.numReactionUsers)) {
        const threadAge = ageHours(thread.createdAt);
        rows.push({
          label: `  ↳ ${thread.repo.split('/').pop()} #${thread.num}`,
          value: `${thread.title.slice(0, 72)} · ${thread.numReactionUsers}❤ ${thread.numComments}💬${
            threadAge === null ? '' : ` · ${shortAge(threadAge)}`
          }`,
          tone: thread.numReactionUsers >= settings.reactionAlert ? 'warn' : undefined,
          href: `https://huggingface.co/${thread.repo}/discussions/${thread.num}`,
        });
        if (thread.numReactionUsers >= settings.reactionAlert) {
          flags.push({
            id: `radar:thread:${thread.repo}#${thread.num}`,
            severity: 'info',
            title: `${thread.numReactionUsers} people want this: ${thread.repo.split('/').pop()} #${thread.num}`,
            detail: `${thread.title.slice(0, 120)} — https://huggingface.co/${thread.repo}/discussions/${thread.num}`,
            source: 'radar',
            raisedAt: iso(),
          });
        }
      }

      raw.push({ family: entry.family, org: entry.org, newest, derivatives, threads });
    }

    store.setExtra('radar', {
      title: 'radar',
      updatedAt: iso(),
      // Partial data is still useful, so one dead endpoint does not mark the whole
      // section down; it shows in `error` and the rest of the rows stand.
      up: failures.length < settings.watch.length,
      rows,
      error: failures.length ? failures.slice(0, 3).join(' | ') : null,
      data: { watch: raw, freshHours: settings.freshHours },
    });
    store.setFlags('radar', flags);
  },
};

export default collector;
