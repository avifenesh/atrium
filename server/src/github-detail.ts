// In-app github reader + composer. The owner manages his OWN github from his OWN
// machine via his OWN gh token on loopback — reading and commenting is a normal
// action, not a security event. No confirm-friction. We only validate inputs so a
// comment can never land on the wrong issue.
//
// One gh graphql call resolves issue OR pr (repository.issueOrPullRequest) and we
// fold PR reviews into the comment thread, chronologically. Comments post via the
// REST issues/comments endpoint, which works for both issues and PRs.
//
// gh holds the token; it never enters this module's returns, errors, or logs.

import { sh } from './util.js';
import type { GithubComment, GithubItemDetail } from '../../shared/types.js';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 60_000;

// Single aliased query: try the node as issue OR pr, select on __typename. PR-only
// fields live under the PullRequest fragment. markdown `body` (not bodyText).
const ITEM_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issueOrPullRequest(number:$number){
      __typename
      ... on Issue {
        title state body url createdAt updatedAt
        author{login}
        labels(first:20){nodes{name}}
        comments(last:40){nodes{id author{login} body createdAt authorAssociation}}
      }
      ... on PullRequest {
        title state body url createdAt updatedAt
        author{login}
        isDraft merged reviewDecision additions deletions changedFiles headRefName baseRefName
        labels(first:20){nodes{name}}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}
        comments(last:40){nodes{id author{login} body createdAt authorAssociation}}
        reviews(last:20){nodes{author{login} body state createdAt authorAssociation}}
      }
    }
  }
}`;

function parseNumber(number: string | number): number {
  // pin a string to exactly the decimal digits given — Number() would otherwise
  // coerce '0x10'->16, '1e3'->1000, '3.0'->3, ' 7 '->7 and silently target a
  // different issue than the literal digits the user typed.
  if (typeof number === 'string' && !/^\d+$/.test(number.trim())) {
    throw new Error('number must be a positive integer');
  }
  const n = typeof number === 'number' ? number : Number(String(number).trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error('number must be a positive integer');
  return n;
}

function splitRepo(repo: string): { owner: string; name: string } {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) throw new Error('repo must be owner/name');
  const slash = repo.indexOf('/');
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function commentNodes(node: any): GithubComment[] {
  const nodes = Array.isArray(node?.comments?.nodes) ? node.comments.nodes : [];
  return nodes.map(
    (c: any): GithubComment => ({
      id: str(c?.id),
      author: str(c?.author?.login),
      body: str(c?.body),
      createdAt: str(c?.createdAt),
      association: typeof c?.authorAssociation === 'string' ? c.authorAssociation : null,
      kind: 'comment',
      reviewState: null,
    }),
  );
}

// PR reviews with a body (or a meaningful state) become thread entries. A bare
// review event with no body and COMMENTED state carries nothing to read, but an
// APPROVED / CHANGES_REQUESTED with no body still tells the owner what happened.
function reviewNodes(node: any): GithubComment[] {
  const nodes = Array.isArray(node?.reviews?.nodes) ? node.reviews.nodes : [];
  const out: GithubComment[] = [];
  for (const r of nodes) {
    const body = str(r?.body);
    const state = typeof r?.state === 'string' ? r.state : null;
    if (!body && (state === null || state === 'COMMENTED' || state === 'PENDING')) continue;
    out.push({
      id: `review:${str(r?.author?.login)}:${str(r?.createdAt)}`,
      author: str(r?.author?.login),
      body,
      createdAt: str(r?.createdAt),
      association: typeof r?.authorAssociation === 'string' ? r.authorAssociation : null,
      kind: 'review',
      reviewState: state,
    });
  }
  return out;
}

/** Fetch one issue or PR with its comment thread (PR reviews folded in chronologically). */
export async function githubItemDetail(repo: string, number: string | number): Promise<GithubItemDetail> {
  const { owner, name } = splitRepo(repo);
  const num = parseNumber(number);

  // gh exits non-zero on a GraphQL error (e.g. NOT_FOUND), but its stderr carries
  // a clean human message — surface that, not the whole command line.
  let out: string;
  try {
    out = await sh(
      'gh',
      ['api', 'graphql', '-f', `query=${ITEM_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${num}`],
      { timeoutMs: TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const tail = msg.includes('—') ? msg.slice(msg.lastIndexOf('—') + 1).trim() : msg;
    if (/could not resolve to an? (issue|pull request|repository)/i.test(tail)) {
      throw new Error(`no issue or pr #${num} in ${owner}/${name}`);
    }
    throw new Error(`github item fetch failed — ${tail || msg}`);
  }

  let node: any;
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed?.errors) && parsed.errors.length) {
      throw new Error(String(parsed.errors[0]?.message ?? 'graphql error'));
    }
    node = parsed?.data?.repository?.issueOrPullRequest;
  } catch (err) {
    throw new Error(`github item parse failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!node) throw new Error(`no issue or pr #${num} in ${owner}/${name}`);

  const isPr = node.__typename === 'PullRequest';
  const comments = [...commentNodes(node), ...(isPr ? reviewNodes(node) : [])].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );

  const labels = Array.isArray(node?.labels?.nodes)
    ? node.labels.nodes.map((l: any) => str(l?.name)).filter(Boolean)
    : [];

  let pr: GithubItemDetail['pr'] = null;
  if (isPr) {
    const ciState = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    pr = {
      isDraft: !!node.isDraft,
      merged: !!node.merged,
      reviewDecision: typeof node.reviewDecision === 'string' ? node.reviewDecision : null,
      ci: typeof ciState === 'string' ? ciState : null,
      additions: Number(node.additions ?? 0),
      deletions: Number(node.deletions ?? 0),
      changedFiles: Number(node.changedFiles ?? 0),
      headRef: str(node.headRefName),
      baseRef: str(node.baseRefName),
    };
  }

  return {
    kind: isPr ? 'pr' : 'issue',
    repo: `${owner}/${name}`,
    number: num,
    title: str(node.title),
    state: str(node.state).toLowerCase(), // OPEN/CLOSED/MERGED -> open/closed/merged
    author: str(node?.author?.login),
    body: str(node.body),
    url: str(node.url),
    labels,
    createdAt: str(node.createdAt),
    updatedAt: str(node.updatedAt),
    comments,
    pr,
  };
}

/** Post a comment to an issue or PR. A normal send button — validate inputs, nothing more. */
export async function githubComment(
  body: any,
): Promise<{ ok: boolean; comment?: GithubComment; error?: string }> {
  let owner: string;
  let name: string;
  let num: number;
  try {
    ({ owner, name } = splitRepo(body?.repo));
    num = parseNumber(body?.number);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const text = body?.body;
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, error: 'comment body is empty' };
  if (text.length > MAX_BODY) return { ok: false, error: `comment body exceeds ${MAX_BODY} characters` };

  try {
    // -f body=<text> sends the field as form data; gh handles escaping. Works for
    // both issues and PRs (PRs are issues for the comments endpoint).
    const out = await sh(
      'gh',
      ['api', '--method', 'POST', `repos/${owner}/${name}/issues/${num}/comments`, '-f', `body=${text}`],
      { timeoutMs: TIMEOUT_MS },
    );
    const c = JSON.parse(out);
    const comment: GithubComment = {
      id: String(c?.id ?? ''),
      author: str(c?.user?.login),
      body: str(c?.body) || text,
      createdAt: str(c?.created_at),
      association: typeof c?.author_association === 'string' ? c.author_association : null,
      kind: 'comment',
      reviewState: null,
    };
    return { ok: true, comment };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
