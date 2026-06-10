import { config } from '../config.js';
import { sh, shTry, iso } from '../util.js';
import { store } from '../state.js';
import type { Collector } from './registry.js';
import type {
  Flag,
  GithubItem,
  GithubNotification,
  GithubPR,
  GithubState,
  RepoCount,
} from '../../../shared/types.js';

// noise orgs are excluded from the attention lanes (actNow/mentions/teamQueue), not from my own PRs
const NOISE_ORGS = config.github.noiseOrgs.map((o) => ` -org:${o}`).join('');

// Single aliased GraphQL search (cost: 1 point). Never use `gh search` here —
// the REST search pool is only 30 req/min and shared with everything else.
const POLL_QUERY = `query { assigned: search(query: "is:open is:issue assignee:${config.github.login} archived:false${NOISE_ORGS}", type: ISSUE, first: 25){ issueCount nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } } } myPRs: search(query: "is:open is:pr author:${config.github.login} archived:false", type: ISSUE, first: 25){ issueCount nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision repository { nameWithOwner } commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } } reviewReq: search(query: "is:open is:pr user-review-requested:${config.github.login} archived:false${NOISE_ORGS}", type: ISSUE, first: 25){ issueCount nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision repository { nameWithOwner } } } } mentions: search(query: "is:open mentions:${config.github.login} archived:false -author:${config.github.login}${NOISE_ORGS}", type: ISSUE, first: 25){ issueCount nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } ... on PullRequest { number title url updatedAt repository { nameWithOwner } } } } teamQueue: search(query: "is:open is:pr review-requested:${config.github.login} -author:${config.github.login} archived:false${NOISE_ORGS} sort:updated-asc", type: ISSUE, first: 25){ issueCount nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision repository { nameWithOwner } } } } rateLimit { cost remaining limit resetAt } }`;

const OWN_REPOS_QUERY = `query { viewer { repositories(first: 100, affiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) { nodes { nameWithOwner isPrivate isArchived pushedAt issues(states: OPEN){ totalCount } pullRequests(states: OPEN){ totalCount } } } } }`;

/** dependabot-style noise excluded from the team queue */
const NOISE_TITLE = /^Bump |^build\(deps\)|Updated attribution files/;

const CI_STATES = new Set(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']);
const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);

// last good state survives poll failures; own repos refresh on a slower cadence
let lastGood: GithubState | null = null;
let ownReposCache: RepoCount[] = [];
let ownReposLastSuccess = 0;

function toItem(n: any, kind: 'issue' | 'pr'): GithubItem {
  const repo = String(n?.repository?.nameWithOwner ?? '');
  return {
    id: `${repo}#${n.number}`,
    repo,
    number: Number(n.number),
    title: String(n.title ?? ''),
    url: String(n.url ?? ''),
    updatedAt: String(n.updatedAt ?? ''),
    kind,
  };
}

function toPR(n: any): GithubPR {
  const decision = typeof n?.reviewDecision === 'string' && REVIEW_DECISIONS.has(n.reviewDecision)
    ? (n.reviewDecision as GithubPR['reviewDecision'])
    : null;
  // commits nodes may be empty and statusCheckRollup is null when no checks ran
  const ciState = n?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const ci = typeof ciState === 'string' && CI_STATES.has(ciState) ? (ciState as GithubPR['ci']) : null;
  return { ...toItem(n, 'pr'), kind: 'pr', isDraft: !!n?.isDraft, reviewDecision: decision, ci };
}

function nodesOf(section: any): any[] {
  const nodes = section?.nodes;
  return Array.isArray(nodes) ? nodes.filter((n) => typeof n?.number === 'number') : [];
}

/** api.github.com subject url -> html url; unknown patterns kept as-is */
function notifUrl(apiUrl: unknown, repo: string): string {
  if (typeof apiUrl !== 'string' || !apiUrl) return repo ? `https://github.com/${repo}` : '';
  const m = apiUrl.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)$/);
  if (m) return `https://github.com/${m[1]}/${m[2] === 'pulls' ? 'pull' : 'issues'}/${m[3]}`;
  return apiUrl;
}

async function fetchNotifications(): Promise<GithubNotification[] | null> {
  const out = await shTry('gh', ['api', 'notifications']);
  if (out === null) return null;
  try {
    const threads = JSON.parse(out);
    if (!Array.isArray(threads)) return null;
    return threads.map((t: any): GithubNotification => {
      const repo = String(t?.repository?.full_name ?? '');
      return {
        id: String(t?.id ?? ''),
        reason: String(t?.reason ?? ''),
        repo,
        title: String(t?.subject?.title ?? ''),
        type: String(t?.subject?.type ?? ''),
        url: notifUrl(t?.subject?.url, repo),
        updatedAt: String(t?.updated_at ?? ''),
        unread: !!t?.unread,
      };
    });
  } catch {
    return null;
  }
}

async function fetchOwnRepos(): Promise<RepoCount[] | null> {
  const out = await shTry('gh', ['api', 'graphql', '-f', `query=${OWN_REPOS_QUERY}`], { timeoutMs: 30_000 });
  if (out === null) return null;
  try {
    const nodes = JSON.parse(out)?.data?.viewer?.repositories?.nodes;
    if (!Array.isArray(nodes)) return null;
    return nodes
      .filter((r: any) => r && !r.isArchived)
      .map((r: any): RepoCount => ({
        repo: String(r.nameWithOwner ?? ''),
        isPrivate: !!r.isPrivate,
        openIssues: Number(r.issues?.totalCount ?? 0),
        openPRs: Number(r.pullRequests?.totalCount ?? 0),
        pushedAt: String(r.pushedAt ?? ''),
      }))
      .filter((r) => r.openIssues + r.openPRs > 0);
  } catch {
    return null;
  }
}

const collector: Collector = {
  name: 'github',
  intervalMs: config.github.pollMs,

  async run(): Promise<void> {
    const flags: Flag[] = [];
    try {
      const out = await sh('gh', ['api', 'graphql', '-f', `query=${POLL_QUERY}`], { timeoutMs: 30_000 });
      const data = JSON.parse(out)?.data;
      if (!data) throw new Error('graphql response had no data');

      const actNow: GithubItem[] = [
        ...nodesOf(data.reviewReq).map(toPR),
        ...nodesOf(data.assigned).map((n) => toItem(n, 'issue')),
      ];
      const actNowIds = new Set(actNow.map((i) => i.id));

      const teamQueue: GithubPR[] = nodesOf(data.teamQueue)
        .map(toPR)
        .filter((pr) => !actNowIds.has(pr.id) && !NOISE_TITLE.test(pr.title));

      const mentions: GithubItem[] = nodesOf(data.mentions).map((n) =>
        toItem(n, n.url?.includes('/pull/') ? 'pr' : 'issue'),
      );

      const myPRs: GithubPR[] = nodesOf(data.myPRs).map(toPR);

      const rl = data.rateLimit;
      const rateLimit = rl
        ? { remaining: Number(rl.remaining ?? 0), limit: Number(rl.limit ?? 0), resetAt: String(rl.resetAt ?? '') }
        : null;
      if (rateLimit && rateLimit.remaining < 500) {
        flags.push({
          id: 'github:rate-limit-low',
          severity: 'warn',
          title: 'GitHub GraphQL rate limit running low',
          detail: `${rateLimit.remaining}/${rateLimit.limit} points left, resets ${rateLimit.resetAt}`,
          source: 'github',
          raisedAt: iso(),
        });
      }

      // failure here is non-fatal: keep the previous notification list
      const notifications = (await fetchNotifications()) ?? lastGood?.notifications ?? [];

      if (Date.now() - ownReposLastSuccess >= config.github.ownReposPollMs) {
        const repos = await fetchOwnRepos();
        if (repos !== null) {
          ownReposCache = repos;
          ownReposLastSuccess = Date.now();
        }
      }

      const state: GithubState = {
        updatedAt: iso(),
        error: null,
        actNow,
        myPRs,
        mentions,
        teamQueue,
        notifications,
        ownRepos: ownReposCache,
        rateLimit,
      };
      lastGood = state;
      store.setSection('github', state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      flags.push({
        id: 'github:poll-failed',
        severity: 'crit',
        title: 'GitHub poll failed',
        detail: msg,
        source: 'github',
        raisedAt: iso(),
      });
      const base: GithubState = lastGood ?? {
        updatedAt: null,
        error: null,
        actNow: [],
        myPRs: [],
        mentions: [],
        teamQueue: [],
        notifications: [],
        ownRepos: [],
        rateLimit: null,
      };
      store.setSection('github', { ...base, error: msg });
    }
    store.setFlags('github', flags);
  },
};

export default collector;
