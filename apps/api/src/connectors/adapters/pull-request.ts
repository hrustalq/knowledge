import { connectorFetch, ConnectorRequestError, type ConnectorContext } from './connector.types.js';
import { githubHeaders, gitlabHeaders, repoHost, type RepoHost } from './repo-archive.js';

/**
 * A pull or merge request on a connected repository: what it changes, and one
 * comment on it (docs/features/35).
 *
 * The sibling of `repo-archive.ts`, and for the same reason it is not an
 * adapter: nothing here moves content between a page and the far side. Both
 * hosts are handled in one place because the drift check does not care which
 * host a change lives on — the diff and the comment are the same idea on both,
 * and a caller branching on host would be two copies of one feature.
 *
 * Plain `fetch` through `connectorFetch`, the house rule, so the SSRF guard
 * runs at the dial and a self-hosted GitLab gets the same private-address
 * treatment as every other connector URL.
 */

/** Past this a pull request is a migration, not a change a page can drift from. */
const MAX_FILES = 300;
const PAGE_SIZE = 100;

export type PullRequestFileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface PullRequestFile {
  /** Repo-relative, after the change. For a removed file, the path it had. */
  path: string;
  /** The path before a rename; null otherwise. */
  previousPath: string | null;
  status: PullRequestFileStatus;
  /** Unified diff hunks, or null where the host withheld them (binary, or too large). */
  patch: string | null;
}

export interface PullRequestFiles {
  files: PullRequestFile[];
  /** True when the change had more files than were read. */
  truncated: boolean;
}

export async function fetchPullRequestFiles(ctx: ConnectorContext, number: number): Promise<PullRequestFiles> {
  const host = repoHost(ctx);
  if (host.kind === 'github') return githubFiles(ctx, host, number);
  if (host.kind === 'gitlab') return gitlabFiles(ctx, host, number);
  throw new Error('pull requests can only be read from GitHub and GitLab repositories');
}

/**
 * Create or update the one comment this product keeps on a pull request.
 *
 * Found again by `marker` — an HTML comment, invisible when rendered — so a
 * pull request that is pushed to six times carries one comment that says the
 * latest thing, not six that each say something older. Only the first page of
 * comments is searched: a pull request with more than a hundred comments and
 * ours not among the first hundred gets a second one, which is a cosmetic cost
 * against a request per page on every push.
 */
export async function upsertPullRequestComment(
  ctx: ConnectorContext,
  number: number,
  marker: string,
  body: string,
): Promise<'created' | 'updated'> {
  const host = repoHost(ctx);
  const text = `${marker}\n${body}`;

  if (host.kind === 'github') {
    const base = `${githubApi(host)}/issues`;
    const headers = { ...githubHeaders(ctx), 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' };
    // Pull request comments are issue comments on GitHub — the review-comment
    // endpoints are for comments anchored to a line, which this is not.
    const existing = await getJson<Array<{ id: number; body?: string }>>(
      ctx,
      `${base}/${number}/comments?per_page=${PAGE_SIZE}`,
      headers,
    );
    const ours = (existing ?? []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
    if (ours) {
      await connectorFetch(
        `${base}/comments/${ours.id}`,
        { method: 'PATCH', headers, body: JSON.stringify({ body: text }), signal: ctx.signal },
        ctx,
      );
      return 'updated';
    }
    await connectorFetch(
      `${base}/${number}/comments`,
      { method: 'POST', headers, body: JSON.stringify({ body: text }), signal: ctx.signal },
      ctx,
    );
    return 'created';
  }

  if (host.kind === 'gitlab') {
    const base = `${gitlabApi(host)}/merge_requests/${number}/notes`;
    const headers = { ...gitlabHeaders(ctx), 'content-type': 'application/json' };
    const existing = await getJson<Array<{ id: number; body?: string; system?: boolean }>>(
      ctx,
      `${base}?per_page=${PAGE_SIZE}&sort=asc`,
      headers,
    );
    const ours = (existing ?? []).find((n) => !n.system && typeof n.body === 'string' && n.body.includes(marker));
    if (ours) {
      await connectorFetch(
        `${base}/${ours.id}`,
        { method: 'PUT', headers, body: JSON.stringify({ body: text }), signal: ctx.signal },
        ctx,
      );
      return 'updated';
    }
    await connectorFetch(base, { method: 'POST', headers, body: JSON.stringify({ body: text }), signal: ctx.signal }, ctx);
    return 'created';
  }

  throw new Error('pull requests can only be commented on in GitHub and GitLab repositories');
}

// --- internals ---

function githubApi(host: RepoHost): string {
  // The same fixed host `repo-archive.ts` reads metadata from: `repoHost` only
  // ever answers `github` for github.com.
  return `https://api.github.com/repos/${encodeURIComponent(host.owner)}/${encodeURIComponent(host.repo)}`;
}

function gitlabApi(host: RepoHost): string {
  return `${host.origin}/api/v4/projects/${encodeURIComponent(`${host.owner}/${host.repo}`)}`;
}

async function getJson<T>(ctx: ConnectorContext, url: string, headers: Record<string, string>): Promise<T | null> {
  const res = await connectorFetch(url, { headers, signal: ctx.signal }, ctx);
  return (await res.json()) as T;
}

async function githubFiles(ctx: ConnectorContext, host: RepoHost, number: number): Promise<PullRequestFiles> {
  const files: PullRequestFile[] = [];
  const headers = { ...githubHeaders(ctx), 'x-github-api-version': '2022-11-28' };
  for (let page = 1; files.length < MAX_FILES; page++) {
    const rows = await getJson<
      Array<{ filename: string; previous_filename?: string; status: string; patch?: string }>
    >(ctx, `${githubApi(host)}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`, headers);
    if (!rows?.length) break;
    for (const row of rows) {
      files.push({
        path: row.filename,
        previousPath: row.previous_filename ?? null,
        status: githubStatus(row.status),
        patch: row.patch ?? null,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { files: files.slice(0, MAX_FILES), truncated: files.length >= MAX_FILES };
}

/** `copied` and `changed` are GitHub's finer shades of modified; `renamed` stays itself. */
function githubStatus(status: string): PullRequestFileStatus {
  if (status === 'added' || status === 'removed' || status === 'renamed') return status;
  return 'modified';
}

interface GitlabDiff {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string;
}

/**
 * `/diffs` is paginated and arrived in GitLab 15.7; `/changes` is the older,
 * unpaginated shape a self-hosted instance may still be running. The newer is
 * tried first and a 404 falls back, rather than probing the version.
 */
async function gitlabFiles(ctx: ConnectorContext, host: RepoHost, number: number): Promise<PullRequestFiles> {
  const headers = gitlabHeaders(ctx);
  const base = `${gitlabApi(host)}/merge_requests/${number}`;
  let diffs: GitlabDiff[] = [];
  try {
    for (let page = 1; diffs.length < MAX_FILES; page++) {
      const rows = await getJson<GitlabDiff[]>(ctx, `${base}/diffs?per_page=${PAGE_SIZE}&page=${page}`, headers);
      if (!rows?.length) break;
      diffs.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
  } catch (err) {
    if (!(err instanceof ConnectorRequestError) || err.status !== 404) throw err;
    const legacy = await getJson<{ changes?: GitlabDiff[] }>(ctx, `${base}/changes`, headers);
    diffs = legacy?.changes ?? [];
  }
  const files = diffs.slice(0, MAX_FILES).map(
    (d): PullRequestFile => ({
      path: d.deleted_file ? d.old_path : d.new_path,
      previousPath: d.renamed_file ? d.old_path : null,
      status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
      patch: d.diff || null,
    }),
  );
  return { files, truncated: diffs.length >= MAX_FILES };
}
