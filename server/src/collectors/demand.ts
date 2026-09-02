// Demand radar beyond the Hub — a plugin collector.
//
// The HF radar (radar.ts) finds buyers inside model-repo discussion tabs, which
// misses everyone who complains where they actually hang out: HN, Reddit, and
// engine issue trackers. This collector runs the SAME hand-picked families and
// the SAME demand/prospect keywords from ~/.config/atrium/signals.json against
// those three surfaces, so tuning the watch list tunes every radar at once.
//
// Same philosophy as radar.ts: DELIBERATELY NOT A FIREHOSE. A result only
// becomes a lead when its title carries both the family and a keyword someone
// types while failing to run the model ("oom", "tok/s", "gguf", "api"...).
// Fresh-window and per-surface caps keep one noisy week from flooding the CRM.
//
// Endpoints: HN Algolia and Reddit search are public and unauthenticated.
// GitHub issue search uses the token file a background service can always read
// (~/.config/tiyuvta/github.env — see the credential law in CLAUDE.md); without
// it the surface degrades to unauthenticated (10 req/min is plenty at 4 queries
// per hour) rather than disappearing.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { crmEvents } from '../crm-events.js';
import { QUALIFIED_AT, scoreLead } from '../lead-relevance.js';
import { signals } from '../signals.js';
import type { SignalItem } from '../../../shared/types.js';
import type { Collector } from './registry.js';

const DAY = 86_400_000;
/** Threads older than this are cold audiences — someone already answered or moved on. */
const FRESH_DAYS = 14;
/** Per family × surface. The CRM is a work queue, not an archive. */
const CAP = 8;

async function githubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const text = await readFile(resolve(homedir(), '.config/tiyuvta/github.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?(GITHUB_TOKEN|GH_TOKEN)\s*=\s*(.*)$/u);
      if (match) {
        const value = match[2].trim().replace(/^["']|["']$/gu, '');
        if (value) return value;
      }
    }
  } catch {
    /* unauthenticated is fine at this query volume */
  }
  return null;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'atrium-demand-radar', ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${new URL(url).host}`);
  return (await response.json()) as T;
}

interface Candidate {
  id: string;
  source: string;
  title: string;
  detail: string | null;
  url: string;
  count: number | null;
  occurredAt: string | null;
}

/** demand-thread when a shippable-format word matches, prospect-thread when the
 *  title shows a buyer failing to run the model. Prospect wins the tie, exactly
 *  like radar.ts — "OOM" outranks "gguf" in the same title. */
function classify(
  title: string,
  demand: string[],
  prospect: string[],
  disqualify: string[],
): 'demand-thread' | 'prospect-thread' | null {
  const lower = title.toLowerCase();
  // a self-hoster tell kills the thread outright — someone naming their local
  // runtime (vllm/ollama/llama.cpp...) is running metal, not shopping for an API
  if (disqualify.some((word) => lower.includes(word))) return null;
  if (prospect.some((word) => lower.includes(word))) return 'prospect-thread';
  if (demand.some((word) => lower.includes(word))) return 'demand-thread';
  return null;
}

const freshEnough = (when: string | null): boolean =>
  when != null && Date.now() - Date.parse(when) <= FRESH_DAYS * DAY;

// --- surfaces ----------------------------------------------------------------

interface HnHit {
  objectID: string;
  title: string | null;
  story_title: string | null;
  url: string | null;
  points: number | null;
  num_comments: number | null;
  created_at: string;
}

async function fetchHn(query: string): Promise<Candidate[]> {
  const since = Math.floor((Date.now() - FRESH_DAYS * DAY) / 1000);
  const payload = await getJson<{ hits: HnHit[] }>(
    `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=30`,
  );
  return (payload.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      id: `hn:${h.objectID}`,
      source: 'hn',
      title: h.title as string,
      detail: `${h.points ?? 0} points · ${h.num_comments ?? 0} comments`,
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      count: h.points ?? null,
      occurredAt: h.created_at ?? null,
    }));
}

/** Reddit's own search JSON 403s datacenter clients, so this goes through the
 *  local searxng (same instance mention-radar.py uses). searxng gives no
 *  publishedDate for reddit results — the time_range=month on the query is the
 *  freshness bound instead, so occurredAt stays null and the caller must not
 *  apply its own fresh-window to these. */
const SEARXNG = 'http://127.0.0.1:8888/search';

interface SearxResult {
  url?: string;
  title?: string;
  content?: string;
}

/** LinkedIn is where the buying companies talk (owner call 2026-08-23: HN and
 *  LinkedIn are the buyer surfaces; reddit/HF are the self-hoster bubble).
 *  Indexed coverage of linkedin.com is shallow but nonzero — posts and pulse
 *  articles surface; a thin stream of real-company hits beats a thick stream
 *  of rig talk. Same searxng instance, same no-publishedDate caveat. */
async function fetchLinkedin(query: string): Promise<Candidate[]> {
  const q = encodeURIComponent(`site:linkedin.com "${query}"`);
  const payload = await getJson<{ results?: SearxResult[] }>(`${SEARXNG}?q=${q}&format=json&time_range=month`);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of payload.results ?? []) {
    if (!r.url || !r.title || !r.url.includes('linkedin.com')) continue;
    // normalize away query strings so the same post from two engines dedupes
    const url = r.url.split('?')[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: `linkedin:${url.replace(/^https?:\/\/(www\.)?linkedin\.com\//, '')}`,
      source: 'linkedin',
      title: r.title.replace(/\s*\|\s*LinkedIn\s*$/i, ''),
      detail: r.content?.slice(0, 140) ?? null,
      url,
      count: null,
      occurredAt: null,
    });
  }
  return out;
}

// X (Twitter) has no usable public search API; the 6h seller-crm-hunt cron job
// (hermes) runs grok CLI's live X search and appends inference-seekers to this
// JSONL. The file is the seam — same rule as mention-radar's hits.jsonl.
const X_DEMAND_FILE = resolve(homedir(), '.config/atrium/x-demand.jsonl');

interface XHit {
  url?: string;
  author?: string;
  text?: string;
  family?: string;
  foundAt?: string;
  /** 'mention' = talks about memra/tiyuvta themselves; anything else = seeker */
  kind?: string;
}

/** Same create-bar the board re-scores. A miss within 2 points of QUALIFIED_AT
 *  goes to the activity feed once, never the pipeline. */
function qualifyOrNearMiss(
  id: string,
  title: string,
  entity: string,
  detail: string | null,
  url: string | null,
): boolean {
  const relevance = scoreLead({ kind: 'lead', title, subtitle: entity, detail });
  if (relevance.qualified) return true;
  if (relevance.score >= QUALIFIED_AT - 2 && !crmEvents.seen('near-miss', id)) {
    crmEvents.emit({
      type: 'near-miss',
      itemId: id,
      title,
      detail: `scored ${relevance.score}/${QUALIFIED_AT}${relevance.labels.length ? ` — ${relevance.labels.join(', ')}` : ''}${detail ? ` · ${detail}` : ''}`,
      url,
    });
  }
  return false;
}

/** X hits are gated twice: x-lead-scan's create-bar, then scoreLead here.
 *  Personal weekly-cap vents and brand mentions do not become signals. */
async function readXDemand(): Promise<Array<Omit<SignalItem, 'firstSeenAt'>>> {
  let raw: string;
  try {
    raw = await readFile(X_DEMAND_FILE, 'utf8');
  } catch {
    return []; // no file yet = hunt hasn't fired, not an outage
  }
  const out: Array<Omit<SignalItem, 'firstSeenAt'>> = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    let hit: XHit;
    try {
      hit = JSON.parse(line) as XHit;
    } catch {
      continue;
    }
    const statusId = hit.url?.match(/\/status\/(\d+)/)?.[1];
    if (!statusId || !hit.text) continue;
    // Legacy rows only: x-lead-scan already emits nothing but kind 'seeker' (its grok
    // prompt refuses brand mentions with no buyer signal, and its writer drops any
    // mention hit). This clears the pre-2026-08-29 rows still in the file. Inbound
    // brand mentions on X have to come back through the scan as seekers, not here.
    if (hit.kind === 'mention') continue;
    if (hit.foundAt != null && !freshEnough(hit.foundAt)) continue;
    // Score exactly the fields the board will re-score (crm.ts toItem runs scoreLead
    // again over title + entity + detail). Gating on the full post while storing a
    // 160-char title meant a row could pass ingest and then show as unqualified,
    // hidden behind the board's own filter.
    const title = hit.text.replace(/\s+/g, ' ').slice(0, 280);
    const entity = hit.family ?? 'inference';
    if (!qualifyOrNearMiss(`x:${statusId}`, title, entity, hit.author ?? null, hit.url ?? null)) continue;
    out.push({
      id: `x:${statusId}`,
      source: 'x',
      kind: 'prospect-thread',
      entity,
      title,
      detail: hit.author ?? null,
      url: hit.url as string,
      count: null,
      delta: null,
      occurredAt: hit.foundAt ?? null,
    });
  }
  return out;
}

interface GhIssue {
  html_url: string;
  title: string;
  comments: number;
  created_at: string;
  repository_url: string;
  pull_request?: unknown;
}

async function fetchGithubIssues(query: string, token: string | null, excludeOwners: string[]): Promise<Candidate[]> {
  const since = new Date(Date.now() - FRESH_DAYS * DAY).toISOString().slice(0, 10);
  // own repos are excluded: an issue the owner filed in his own tracker is work,
  // not a lead — without this the first live run was half wayfinder/memra items
  const exclude = excludeOwners.map((owner) => ` -user:${owner}`).join('');
  const q = `"${query}" in:title is:issue is:open created:>${since}${exclude}`;
  const payload = await getJson<{ items?: GhIssue[] }>(
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=30`,
    token ? { authorization: `Bearer ${token}` } : {},
  );
  return (payload.items ?? [])
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      id: `gh-issue:${issue.html_url.replace('https://github.com/', '')}`,
      source: 'gh-issue',
      title: issue.title,
      detail: `${issue.repository_url.split('/').slice(-2).join('/')} · ${issue.comments} comments`,
      url: issue.html_url,
      count: issue.comments,
      occurredAt: issue.created_at ?? null,
    }));
}

// --- self-comment detection ------------------------------------------------
//
// Same contract as the HF radar's: a thread the owner already answered is
// engaged, not an action item — and the owner answers AFTER the lead appears,
// so unanswered issues are re-checked on a slow clock, not just once.

const selfCheckAt = new Map<string, number>();
const SELF_RECHECK_MS = 2 * 3_600_000;

function shouldSelfCheck(id: string): boolean {
  const lead = signals.lead(id);
  if (lead?.status === 'engaged' || lead?.status === 'dismissed') return false;
  const last = selfCheckAt.get(id);
  if (last != null && Date.now() - last < SELF_RECHECK_MS) return false;
  selfCheckAt.set(id, Date.now());
  return true;
}

/** id shape: gh-issue:<owner>/<repo>/issues/<num> */
async function ghSelfCommented(id: string, login: string, token: string | null): Promise<boolean> {
  const path = id.slice('gh-issue:'.length);
  const comments = await getJson<Array<{ user?: { login?: string } }>>(
    `https://api.github.com/repos/${path}/comments?per_page=100`,
    token ? { authorization: `Bearer ${token}` } : {},
  );
  return comments.some((c) => c.user?.login?.toLowerCase() === login.toLowerCase());
}

// --- collector -----------------------------------------------------------------

const collector: Collector = {
  name: 'demand',
  intervalMs: 60 * 60_000,

  async run() {
    const watch = signals.watch();
    const demand = watch.demandKeywords.map((k) => k.toLowerCase());
    const prospect = (watch.prospectKeywords ?? []).map((k) => k.toLowerCase());
    const disqualify = (watch.disqualifyKeywords ?? []).map((k) => k.toLowerCase());

    if (watch.radarWatch.length === 0 || (demand.length === 0 && prospect.length === 0)) {
      await signals.publish('demand', [], null);
      return;
    }

    const token = await githubToken();
    const gh = (config as unknown as { github?: { login?: string; ownOrgs?: string[] } }).github ?? {};
    const excludeOwners = [gh.login, ...(gh.ownOrgs ?? [])].filter((o): o is string => !!o);
    const items: Array<Omit<SignalItem, 'firstSeenAt'>> = [];
    const failures: string[] = [];
    const seen = new Set<string>();

    for (const entry of watch.radarWatch) {
      // the `match` string is the searchable family name ("Qwen3.8"); the display
      // family ("Qwen3.8 27B") often over-specifies and misses half the posts
      const query = entry.match ?? entry.family;

      const surfaces: Array<[string, () => Promise<Candidate[]>]> = [
        ['hn', () => fetchHn(query)],
        ['linkedin', () => fetchLinkedin(query)],
        ['gh-issue', () => fetchGithubIssues(query, token, excludeOwners)],
      ];

      for (const [surface, fetcher] of surfaces) {
        let candidates: Candidate[] = [];
        try {
          candidates = await fetcher();
        } catch (error) {
          failures.push(`${surface}/${query}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        let kept = 0;
        for (const candidate of candidates.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
          if (kept >= CAP) break;
          if (seen.has(candidate.id)) continue; // families can share a thread (comparison posts)
          // null occurredAt = the surface already bounded freshness at the query
          // (searxng time_range); a real timestamp still has to pass the window
          if (candidate.occurredAt != null && !freshEnough(candidate.occurredAt)) continue;
          const kind = classify(candidate.title, demand, prospect, disqualify);
          if (!kind) continue;
          seen.add(candidate.id);
          const title = candidate.title.slice(0, 160);
          if (!qualifyOrNearMiss(candidate.id, title, entry.family, candidate.detail, candidate.url)) continue;
          kept += 1;
          items.push({
            id: candidate.id,
            source: candidate.source,
            kind,
            entity: entry.family,
            title,
            detail: candidate.detail,
            url: candidate.url,
            count: candidate.count,
            delta: null,
            occurredAt: candidate.occurredAt,
          });
        }
      }
    }

    // Buyer-pain hunts (owner + research, 2026-08-23): standalone searches for
    // the phrases the two buyer profiles type when provider-shopping — no
    // family name required, the query IS the qualification. Only the
    // self-hoster disqualify list can kill a hit. HN and LinkedIn only: those
    // are the buyer surfaces.
    const buyerQueries = watch.buyerQueries ?? [];
    for (const query of buyerQueries) {
      const surfaces: Array<[string, () => Promise<Candidate[]>]> = [
        ['hn', () => fetchHn(query)],
        ['linkedin', () => fetchLinkedin(query)],
      ];
      for (const [surface, fetcher] of surfaces) {
        let candidates: Candidate[] = [];
        try {
          candidates = await fetcher();
        } catch (error) {
          failures.push(`${surface}/${query}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        let kept = 0;
        for (const candidate of candidates.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
          if (kept >= CAP) break;
          if (seen.has(candidate.id)) continue;
          if (candidate.occurredAt != null && !freshEnough(candidate.occurredAt)) continue;
          const lower = candidate.title.toLowerCase();
          if (disqualify.some((word) => lower.includes(word))) continue;
          seen.add(candidate.id);
          const title = candidate.title.slice(0, 160);
          const entity = `buyer hunt · ${query}`;
          if (!qualifyOrNearMiss(candidate.id, title, entity, candidate.detail, candidate.url)) continue;
          kept += 1;
          items.push({
            id: candidate.id,
            source: candidate.source,
            kind: 'prospect-thread',
            entity,
            title,
            detail: candidate.detail,
            url: candidate.url,
            count: candidate.count,
            delta: null,
            occurredAt: candidate.occurredAt,
          });
        }
      }
    }

    for (const hit of await readXDemand()) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      items.push(hit);
    }

    // the owner's own replies mark gh-issue leads engaged, exactly like the HF
    // radar's self-comment detection — bounded by the 2h recheck clock
    if (gh.login) {
      for (const item of items) {
        if (!item.id.startsWith('gh-issue:') || !shouldSelfCheck(item.id)) continue;
        try {
          if (await ghSelfCommented(item.id, gh.login, token)) {
            await signals.setLead(item.id, 'engaged', `auto: ${gh.login} commented`);
          }
        } catch (error) {
          failures.push(`self-check ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    await signals.publish('demand', items, failures.length ? failures.slice(0, 3).join(' | ') : null);
  },
};

export default collector;
