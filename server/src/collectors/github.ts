import { config } from '../config.js';
import { sh, shTry, iso } from '../util.js';
import { store } from '../state.js';
import { mutes } from '../mutes.js';
import type { Collector } from './registry.js';
import type {
  Flag,
  GithubItem,
  GithubNotification,
  GithubPR,
  GithubState,
  OrgItem,
  RepoCount,
} from '../../../shared/types.js';

// noise orgs are excluded from the attention lanes (actNow/mentions/teamQueue), not from my own PRs
const NOISE_ORGS = config.github.noiseOrgs.map((o) => ` -org:${o}`).join('');

// org queue scope: each watched org plus his own personal repos. GitHub search ORs
// same-qualifier terms, so `org:agent-sh user:avifenesh` returns items in EITHER
// (verified: combined issueCount == orgOnly + userOnly). One aliased sub-query, cost 1.
const OWN_ORGS = new Set(config.github.ownOrgs);
const ORG_FILTER = [...config.github.ownOrgs.map((o) => `org:${o}`), `user:${config.github.login}`].join(' ');
// bots authored items are noise. The `app/` prefix excludes GitHub Apps in search; we
// also defensively drop by author type + login when mapping (imgbot etc. lack the prefix).
const BOT_AUTHOR_FILTER = ' -author:app/dependabot -author:app/renovate -author:app/github-actions';
const BOT_LOGINS = new Set(['dependabot', 'github-actions', 'renovate']);
const REVIEW_BOT_NOISE_LOGINS = new Set(config.github.reviewBotNoiseLogins.map((login) => canonicalLogin(login)));
const NOTIFICATION_ENRICH_LIMIT = 30;

// Single aliased GraphQL search (cost: 1 point). Never use `gh search` here —
// the REST search pool is only 30 req/min and shared with everything else.
const POLL_QUERY = `query { assigned: search(query: "is:open is:issue assignee:${config.github.login} archived:false${NOISE_ORGS}", type: ISSUE, first: 25){ issueCount nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } } } myPRs: search(query: "is:open is:pr author:${config.github.login} archived:false", type: ISSUE, first: 25){ issueCount nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision repository { nameWithOwner } commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } } reviewReq: search(query: "is:open is:pr user-review-requested:${config.github.login} archived:false${NOISE_ORGS}", type: ISSUE, first: 25){ issueCount nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision repository { nameWithOwner } } } } mentions: search(query: "is:open mentions:${config.github.login} archived:false -author:${config.github.login}${NOISE_ORGS}", type: ISSUE, first: 25){ issueCount nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } ... on PullRequest { number title url updatedAt repository { nameWithOwner } } } } teamQueue: search(query: "is:open is:pr review-requested:${config.github.login} -author:${config.github.login} archived:false${NOISE_ORGS} sort:updated-asc", type: ISSUE, first: 25){ issueCount nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision repository { nameWithOwner } } } } orgExt: search(query: "is:open -author:${config.github.login}${BOT_AUTHOR_FILTER} archived:false ${ORG_FILTER}", type: ISSUE, first: 50){ issueCount nodes { __typename ... on PullRequest { number title url createdAt updatedAt isDraft reviewDecision author { login __typename } repository { nameWithOwner } commits(last:1){nodes{commit{statusCheckRollup{state}}}} } ... on Issue { number title url createdAt updatedAt author { login __typename } repository { nameWithOwner } } } } rateLimit { cost remaining limit resetAt } }`;

const REPO_FIELDS =
  'nodes { nameWithOwner isPrivate isArchived pushedAt issues(states: OPEN){ totalCount } pullRequests(states: OPEN){ totalCount } }';
// owner treats his orgs' repos exactly like his own (agent-sh: "even more important")
const OWN_REPOS_QUERY = `query { viewer { repositories(first: 100, affiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) { ${REPO_FIELDS} } } ${config.github.ownOrgs
  .map((o, i) => `org${i}: organization(login: "${o}") { repositories(first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) { ${REPO_FIELDS} } }`)
  .join(' ')} }`;

/** dependabot-style noise excluded from the team queue */
const NOISE_TITLE = /^Bump |^build\(deps\)|Updated attribution files/;

const CI_STATES = new Set(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']);
const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
type NotificationActivity = NonNullable<GithubNotification['latestActivity']>;

// last good state survives poll failures; own repos refresh on a slower cadence
let lastGood: GithubState | null = null;
let ownReposCache: RepoCount[] = [];
let ownReposLastSuccess = 0;
// consecutive failed polls — gates the crit flag so a transient 5xx that heals
// next cycle never pages. Reset to 0 on any successful poll.
let consecutiveFailures = 0;

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

/** True for any GitHub App / bot author. author.__typename === 'Bot' catches every
 *  GitHub App (dependabot, renovate, github-actions, imgbot, ...) regardless of login.
 *  The login checks are belt-and-suspenders for missing/odd type info. */
function isBotAuthor(author: any): boolean {
  if (!author) return false;
  if (author.__typename === 'Bot') return true;
  const login = typeof author.login === 'string' ? author.login.toLowerCase() : '';
  return login.endsWith('[bot]') || BOT_LOGINS.has(login);
}

/** Map an orgExt search node -> OrgItem. Returns null for own/bot-authored nodes (defensive). */
function toOrgItem(n: any): OrgItem | null {
  const author = n?.author;
  const login = typeof author?.login === 'string' ? author.login : '';
  // his own authored items live in myPRs/actNow, not the org queue; bots are noise
  if (!login || login === config.github.login || isBotAuthor(author)) return null;
  const repo = String(n?.repository?.nameWithOwner ?? '');
  if (!repo) return null;
  const kind: 'issue' | 'pr' = n?.__typename === 'PullRequest' ? 'pr' : 'issue';
  const owner = repo.split('/')[0] ?? '';
  const decision =
    typeof n?.reviewDecision === 'string' && REVIEW_DECISIONS.has(n.reviewDecision)
      ? (n.reviewDecision as OrgItem['reviewDecision'])
      : null;
  const ciState = n?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const ci = typeof ciState === 'string' && CI_STATES.has(ciState) ? (ciState as OrgItem['ci']) : null;
  return {
    id: `${repo}#${n.number}`,
    repo,
    number: Number(n.number),
    title: String(n.title ?? ''),
    url: String(n.url ?? ''),
    updatedAt: String(n.updatedAt ?? ''),
    createdAt: String(n.createdAt ?? ''),
    kind,
    author: login,
    scope: OWN_ORGS.has(owner) ? 'org' : 'own',
    isDraft: kind === 'pr' ? !!n?.isDraft : false,
    reviewDecision: decision,
    ci,
    lane: kind === 'pr' ? 'review' : 'triage',
  };
}

/** Rank most-waiting-first: (1) review non-draft PRs oldest updatedAt, (2) review draft
 *  PRs, (3) triage issues oldest updatedAt. Cap 50. */
function rankOrgQueue(items: OrgItem[]): OrgItem[] {
  const tier = (it: OrgItem): number => {
    if (it.lane === 'review') return it.isDraft ? 1 : 0;
    return 2;
  };
  return items
    .slice()
    .sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      if (ta !== tb) return ta - tb;
      // oldest updatedAt first = longest someone has waited
      return a.updatedAt.localeCompare(b.updatedAt);
    })
    .slice(0, 50);
}

const ORG_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function nodesOf(section: any): any[] {
  const nodes = section?.nodes;
  return Array.isArray(nodes) ? nodes.filter((n) => typeof n?.number === 'number') : [];
}

function canonicalLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, '');
}

function splitRepoName(repo: string): { owner: string; name: string } | null {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) return null;
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

function apiPath(apiUrl: string): string | null {
  try {
    const url = new URL(apiUrl);
    if (url.hostname !== 'api.github.com') return null;
    return url.pathname.replace(/^\/+/, '');
  } catch {
    return null;
  }
}

function parseApiItemUrl(apiUrl: unknown): { repo: string; kind: 'pulls' | 'issues'; number: number } | null {
  if (typeof apiUrl !== 'string') return null;
  const path = apiPath(apiUrl);
  if (!path) return null;
  const m = path.match(/^repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)$/);
  if (!m) return null;
  return { repo: m[1], kind: m[2] as 'pulls' | 'issues', number: Number(m[3]) };
}

function itemIdFromApiUrl(apiUrl: unknown): string | null {
  const item = parseApiItemUrl(apiUrl);
  return item ? `${item.repo}#${item.number}` : null;
}

function parseApiCommentUrl(apiUrl: unknown): { path: string; kind: 'comment' | 'review_comment' } | null {
  if (typeof apiUrl !== 'string') return null;
  const path = apiPath(apiUrl);
  if (!path) return null;
  if (/^repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.test(path)) return { path, kind: 'comment' };
  if (/^repos\/[^/]+\/[^/]+\/pulls\/comments\/\d+$/.test(path)) return { path, kind: 'review_comment' };
  return null;
}

function activityFromRestComment(node: any, kind: 'comment' | 'review_comment'): NotificationActivity | null {
  const actor = typeof node?.user?.login === 'string' ? node.user.login : '';
  if (!actor) return null;
  return {
    kind,
    actor,
    actorType: typeof node?.user?.type === 'string' ? node.user.type : null,
    state: null,
    updatedAt: String(node?.updated_at ?? node?.created_at ?? ''),
  };
}

function activityFromGraphNode(node: any, kind: NotificationActivity['kind']): NotificationActivity | null {
  const actor = typeof node?.author?.login === 'string' ? node.author.login : '';
  if (!actor) return null;
  return {
    kind,
    actor,
    actorType: typeof node?.author?.__typename === 'string' ? node.author.__typename : null,
    state: typeof node?.state === 'string' ? node.state : null,
    updatedAt: String(node?.updatedAt ?? node?.submittedAt ?? node?.createdAt ?? ''),
  };
}

async function fetchRestCommentActivity(apiUrl: unknown): Promise<NotificationActivity | null> {
  const parsed = parseApiCommentUrl(apiUrl);
  if (!parsed) return null;
  const out = await shTry('gh', ['api', parsed.path], { timeoutMs: 10_000 });
  if (out === null) return null;
  try {
    return activityFromRestComment(JSON.parse(out), parsed.kind);
  } catch {
    return null;
  }
}

const PR_NOTIFICATION_ACTIVITY_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      comments(last:5){nodes{author{login __typename} createdAt updatedAt}}
      latestReviews(last:10){nodes{author{login __typename} state submittedAt updatedAt}}
      reviewThreads(last:20){nodes{comments(last:5){nodes{author{login __typename} createdAt updatedAt path outdated}}}}
    }
  }
}`;

async function fetchPullRequestActivity(repo: string, number: number): Promise<NotificationActivity | null> {
  const parts = splitRepoName(repo);
  if (!parts) return null;
  const out = await shTry(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${PR_NOTIFICATION_ACTIVITY_QUERY}`,
      '-F',
      `owner=${parts.owner}`,
      '-F',
      `name=${parts.name}`,
      '-F',
      `number=${number}`,
    ],
    { timeoutMs: 15_000 },
  );
  if (out === null) return null;
  try {
    const pr = JSON.parse(out)?.data?.repository?.pullRequest;
    const candidates: NotificationActivity[] = [];
    for (const c of pr?.comments?.nodes ?? []) {
      const a = activityFromGraphNode(c, 'comment');
      if (a?.updatedAt) candidates.push(a);
    }
    for (const r of pr?.latestReviews?.nodes ?? []) {
      const a = activityFromGraphNode(r, 'review');
      if (a?.updatedAt) candidates.push(a);
    }
    for (const thread of pr?.reviewThreads?.nodes ?? []) {
      for (const c of thread?.comments?.nodes ?? []) {
        const a = activityFromGraphNode(c, 'review_comment');
        if (a?.updatedAt) candidates.push(a);
      }
    }
    return candidates.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1) ?? null;
  } catch {
    return null;
  }
}

export async function fetchNotificationActivity(thread: any): Promise<NotificationActivity | null> {
  const subjectType = String(thread?.subject?.type ?? '');
  const latestUrl = thread?.subject?.latest_comment_url;

  const restComment = await fetchRestCommentActivity(latestUrl);
  if (restComment) return restComment;

  const latestItem = parseApiItemUrl(latestUrl);
  if (latestItem?.kind === 'pulls') return fetchPullRequestActivity(latestItem.repo, latestItem.number);

  if (subjectType === 'PullRequest') {
    const subjectItem = parseApiItemUrl(thread?.subject?.url);
    if (subjectItem?.kind === 'pulls') return fetchPullRequestActivity(subjectItem.repo, subjectItem.number);
  }

  return null;
}

export function reviewBotNoise(activity: NotificationActivity | null): GithubNotification['noise'] {
  if (!activity || (activity.kind !== 'review' && activity.kind !== 'review_comment')) return null;
  const login = canonicalLogin(activity.actor);
  if (!REVIEW_BOT_NOISE_LOGINS.has(login)) return null;
  return {
    kind: 'review-bot',
    groupKey: `review-bot:${login}`,
    label: `${activity.actor} review bot`,
    detail: activity.kind === 'review' ? 'PR review summary' : 'inline PR review comment',
  };
}

export async function githubNotificationFromThread(thread: any, enrich = true): Promise<GithubNotification> {
  const repo = String(thread?.repository?.full_name ?? '');
  const activity = enrich ? await fetchNotificationActivity(thread) : null;
  return {
    id: String(thread?.id ?? ''),
    reason: String(thread?.reason ?? ''),
    repo,
    title: String(thread?.subject?.title ?? ''),
    type: String(thread?.subject?.type ?? ''),
    url: notifUrl(thread?.subject?.url, repo),
    updatedAt: String(thread?.updated_at ?? ''),
    unread: !!thread?.unread,
    itemId: itemIdFromApiUrl(thread?.subject?.url),
    latestActivity: activity,
    noise: reviewBotNoise(activity),
  };
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
    const notifications: GithubNotification[] = [];
    for (const [i, t] of threads.entries()) {
      notifications.push(await githubNotificationFromThread(t, i < NOTIFICATION_ENRICH_LIMIT));
    }
    return notifications;
  } catch {
    return null;
  }
}

async function fetchOwnRepos(): Promise<RepoCount[] | null> {
  const out = await shTry('gh', ['api', 'graphql', '-f', `query=${OWN_REPOS_QUERY}`], { timeoutMs: 30_000 });
  if (out === null) return null;
  try {
    const data = JSON.parse(out)?.data;
    const nodes = [
      ...(data?.viewer?.repositories?.nodes ?? []),
      ...config.github.ownOrgs.flatMap((_, i) => data?.[`org${i}`]?.repositories?.nodes ?? []),
    ];
    if (nodes.length === 0) return null;
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

      // external PRs/issues on repos he owns/admins, authored by others (not him, not bots).
      // ranked above myPRs: a person blocked on him beats a status update.
      const orgQueue: OrgItem[] = rankOrgQueue(
        nodesOf(data.orgExt)
          .map(toOrgItem)
          .filter((it): it is OrgItem => it !== null),
      );

      const staleNow = Date.now();
      const staleCount = orgQueue.filter(
        (it) =>
          it.lane === 'review' &&
          !it.isDraft &&
          it.updatedAt !== '' &&
          staleNow - new Date(it.updatedAt).getTime() > ORG_STALE_MS,
      ).length;
      if (staleCount > 0) {
        flags.push({
          id: 'github:org-pr-stale',
          severity: 'info',
          title: 'External PRs waiting on review',
          detail: `${staleCount} PR${staleCount === 1 ? '' : 's'} on your repos untouched for over 7 days`,
          source: 'github',
          raisedAt: iso(),
        });
      }

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
        orgQueue,
        myPRs,
        mentions,
        teamQueue,
        notifications,
        ownRepos: ownReposCache,
        rateLimit,
      };
      lastGood = state;
      consecutiveFailures = 0; // healthy poll clears the failure streak
      store.setSection('github', state);

      // "quiet until activity" wake-up: any seen item that moved since its mute
      // was set gets unmuted and resurfaces. Failure here must not fail the poll.
      const seen = new Map<string, string | null>();
      for (const it of [...actNow, ...orgQueue, ...myPRs, ...mentions, ...teamQueue]) {
        seen.set(it.id, it.updatedAt);
      }
      await mutes.resurface(seen).catch((e) => {
        console.error('[github] resurface failed:', e instanceof Error ? e.message : e);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consecutiveFailures++;
      // The dashboard error updates on every failure (visual), but the crit flag —
      // which is what pages the phone via notify.ts — only raises once failures
      // have persisted past the threshold. A lone transient 5xx stays silent.
      if (consecutiveFailures >= config.github.failThreshold) {
        flags.push({
          id: 'github:poll-failed',
          severity: 'crit',
          title: 'GitHub poll failed',
          detail: `${consecutiveFailures} consecutive failures — ${msg}`,
          source: 'github',
          raisedAt: iso(),
        });
      }
      const base: GithubState = lastGood ?? {
        updatedAt: null,
        error: null,
        actNow: [],
        orgQueue: [],
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
