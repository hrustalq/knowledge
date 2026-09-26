import { timingSafeEqual } from 'node:crypto';
import type { AgentRunPullRequest } from '@knowledge/contracts';
import { verifyHubSignature } from '../webhook-payload.js';

/**
 * Reading a pull or merge request delivery (docs/features/35).
 *
 * Pure and Nest-free, like `webhook-payload.ts` beside it, so the two hosts'
 * payload shapes and the action filter can be tested without a server. Both
 * webhook controllers call in here: the App-level one for GitHub, the
 * per-connector one for a hook somebody configured on the repository by hand —
 * which is the only kind GitLab has.
 */

/** A delivery that asks for a drift check, and the change it names. */
export interface PullRequestDelivery {
  pullRequest: AgentRunPullRequest;
}

/**
 * Whether a per-connector delivery is authentic, for either host.
 *
 * GitLab sends the shared secret back verbatim in `X-Gitlab-Token`; GitHub
 * signs the body. `markdown-git`'s own check compared GitLab's token with `!==`,
 * which is fine for a sync trigger and not for a trigger that spends model
 * calls, so this one compares in constant time like the HMAC path does.
 */
export function verifyRepoDelivery(headers: Record<string, string>, rawBody: string, secret: string): boolean {
  const gitlabToken = headers['x-gitlab-token'];
  if (gitlabToken !== undefined) {
    const a = Buffer.from(gitlabToken, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return verifyHubSignature(headers, rawBody, secret);
}

/**
 * Whether this delivery is a pull or merge request event at all — asked before
 * verification decides which path handles it, so a push keeps going to sync.
 */
export function isPullRequestEvent(headers: Record<string, string>, payload: Record<string, any> | null): boolean {
  if (headers['x-github-event'] === 'pull_request') return true;
  return payload?.object_kind === 'merge_request';
}

/**
 * The GitHub actions that mean "the change a reviewer is looking at is new".
 *
 * `synchronize` is a push to the branch — the one that matters most, because it
 * is how a change grows the part that makes a page wrong. `ready_for_review` is
 * a draft becoming real. `closed`, `edited`, `labeled` and the rest say nothing
 * about the code, and a check fired on a title edit is spend with no news in it.
 */
const GITHUB_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

export function readGithubPullRequest(event: string, payload: Record<string, any> | null): PullRequestDelivery | null {
  if (event !== 'pull_request' || !payload) return null;
  if (!GITHUB_ACTIONS.has(String(payload.action ?? ''))) return null;
  const pr = payload.pull_request;
  // A draft is somebody still working it out; checking it on every push would
  // bill each half-finished commit. `ready_for_review` picks it up when it is not.
  if (!pr || pr.draft === true || pr.state !== 'open') return null;
  // A fork is somebody outside the repository proposing a change, and a check
  // spends the connector owner's AI budget. On a public repository that is a
  // stranger's button on somebody else's bill, so only same-repository pull
  // requests are checked. A head with no repository is a fork since deleted.
  const headRepo: unknown = pr.head?.repo?.id;
  if (headRepo === undefined || headRepo === null || headRepo !== pr.base?.repo?.id) return null;
  const number = Number(pr.number);
  const headSha = typeof pr.head?.sha === 'string' ? pr.head.sha : '';
  if (!Number.isInteger(number) || number <= 0 || !headSha) return null;
  return {
    pullRequest: {
      number,
      title: String(pr.title ?? '').slice(0, 300),
      url: typeof pr.html_url === 'string' ? pr.html_url : '',
      headSha,
      headRef: typeof pr.head?.ref === 'string' ? pr.head.ref : null,
      baseRef: typeof pr.base?.ref === 'string' ? pr.base.ref : null,
      author: typeof pr.user?.login === 'string' ? pr.user.login : null,
    },
  };
}

/**
 * GitLab's merge request hook, which is one event with an `action`.
 *
 * `update` fires for a new commit **and** for a title, label or assignee edit;
 * only the first carries `oldrev`, which is how GitLab's own docs say to tell
 * them apart. Anything else is not a change to the code under review.
 */
export function readGitlabMergeRequest(payload: Record<string, any> | null): PullRequestDelivery | null {
  if (!payload || payload.object_kind !== 'merge_request') return null;
  const attrs = payload.object_attributes;
  if (!attrs) return null;
  const action = String(attrs.action ?? '');
  const relevant = action === 'open' || action === 'reopen' || (action === 'update' && !!attrs.oldrev);
  if (!relevant || attrs.state !== 'opened') return null;
  if (attrs.draft === true || attrs.work_in_progress === true) return null;
  // The fork rule, GitLab's spelling of it — see `readGithubPullRequest`.
  if (attrs.source_project_id !== undefined && attrs.source_project_id !== attrs.target_project_id) return null;
  const number = Number(attrs.iid);
  const headSha = typeof attrs.last_commit?.id === 'string' ? attrs.last_commit.id : '';
  if (!Number.isInteger(number) || number <= 0 || !headSha) return null;
  return {
    pullRequest: {
      number,
      title: String(attrs.title ?? '').slice(0, 300),
      url: typeof attrs.url === 'string' ? attrs.url : '',
      headSha,
      headRef: typeof attrs.source_branch === 'string' ? attrs.source_branch : null,
      baseRef: typeof attrs.target_branch === 'string' ? attrs.target_branch : null,
      author: typeof payload.user?.username === 'string' ? payload.user.username : null,
    },
  };
}

/** Either host, from a per-connector delivery. */
export function readPullRequestDelivery(
  headers: Record<string, string>,
  payload: Record<string, any> | null,
): PullRequestDelivery | null {
  const event = headers['x-github-event'];
  return event ? readGithubPullRequest(event, payload) : readGitlabMergeRequest(payload);
}
