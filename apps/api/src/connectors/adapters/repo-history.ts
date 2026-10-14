import { globToRegExp } from '../../common/glob.js';
import { connectorFetch, type ConnectorContext } from './connector.types.js';
import { githubHeaders, gitlabHeaders, repoHost, type RepoHost } from './repo-archive.js';

/**
 * A repository's history, as release notes need it (docs/features/46): its
 * tags, the commits between two refs, and which merged pull requests carry a
 * label. GitHub and GitLab over their REST APIs through `connectorFetch`, with
 * the same credential the archive download uses. Any other host has no
 * history API we speak, and says so.
 *
 * Everything read here is repository bytes — commit messages, PR titles,
 * labels — and is treated as such downstream: links are built here from the
 * host plus a sha or a number, never taken from a message, and nothing here is
 * ever placed in a prompt unwrapped.
 */

export interface RepoTag {
  name: string;
  sha: string;
}

export interface RepoCommit {
  sha: string;
  message: string;
  date: string | null;
}

export interface CommitRange {
  commits: RepoCommit[];
  /** The host had more than the cap. */
  truncated: boolean;
  total: number;
  /** Paths the range touched, or null when the host did not list them (no base, or too many). */
  files: string[] | null;
}

/** Tags read from the host. Enough for any release history worth rendering. */
const MAX_TAGS = 300;
const PAGE = 100;

export class RepoHistoryUnsupportedError extends Error {
  constructor(host: string) {
    super(`release notes need a GitHub or GitLab repository; ${host} has no history API this product reads`);
    this.name = 'RepoHistoryUnsupportedError';
  }
}

export async function listTags(ctx: ConnectorContext, pattern: string): Promise<RepoTag[]> {
  const host = supportedHost(ctx);
  const match = globToRegExp(pattern);
  const tags: RepoTag[] = [];
  for (let page = 1; tags.length < MAX_TAGS; page += 1) {
    const rows =
      host.kind === 'github'
        ? ((await getJson(ctx, `${githubApi(host)}/tags?per_page=${PAGE}&page=${page}`)) as Array<{
            name: string;
            commit: { sha: string };
          }>).map((t) => ({ name: t.name, sha: t.commit.sha }))
        : ((await getJson(ctx, `${gitlabApi(host)}/repository/tags?per_page=${PAGE}&page=${page}`)) as Array<{
            name: string;
            commit: { id: string };
          }>).map((t) => ({ name: t.name, sha: t.commit.id }));
    tags.push(...rows);
    if (rows.length < PAGE) break;
  }
  return sortTagsByVersion(tags.filter((t) => match.test(t.name)));
}

/**
 * The commits from `base` (exclusive) to `head`, oldest first, capped at
 * `max`. With no base — the first release — it is the head's own history,
 * capped the same way.
 */
export async function compareCommits(
  ctx: ConnectorContext,
  base: string | null,
  head: string,
  max: number,
): Promise<CommitRange> {
  const host = supportedHost(ctx);
  if (host.kind === 'github') {
    if (!base) return githubHistory(ctx, host, head, max);
    const body = (await getJson(
      ctx,
      `${githubApi(host)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=250`,
    )) as {
      total_commits?: number;
      commits?: Array<{ sha: string; commit: { message: string; committer?: { date?: string } } }>;
      files?: Array<{ filename: string }>;
    };
    const all = (body.commits ?? []).map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.committer?.date ?? null }));
    const total = body.total_commits ?? all.length;
    // GitHub lists at most 300 files; past that the list is a sample, not the change.
    const files = body.files && body.files.length < 300 ? body.files.map((f) => f.filename) : null;
    // The compare endpoint returns the *oldest* 250; a longer range keeps the newest `max`.
    const commits = all.slice(-max);
    return { commits, truncated: total > commits.length, total, files };
  }

  if (!base) return gitlabHistory(ctx, host, head, max);
  const body = (await getJson(
    ctx,
    `${gitlabApi(host)}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
  )) as {
    commits?: Array<{ id: string; message: string; committed_date?: string }>;
    diffs?: Array<{ new_path: string }>;
  };
  const all = (body.commits ?? []).map((c) => ({ sha: c.id, message: c.message, date: c.committed_date ?? null }));
  const commits = all.slice(-max);
  return {
    commits,
    truncated: all.length > commits.length,
    total: all.length,
    files: body.diffs ? body.diffs.map((d) => d.new_path) : null,
  };
}

/**
 * Merged pull (merge) request numbers carrying any of `labels`, with the
 * labels they carry. One search per label, not one request per commit: the
 * commits are tied to their requests by the number in their message.
 */
export async function mergedRequestsWithLabels(
  ctx: ConnectorContext,
  labels: string[],
): Promise<Map<number, string[]>> {
  const host = supportedHost(ctx);
  const out = new Map<number, string[]>();
  for (const label of labels.slice(0, 10)) {
    const numbers =
      host.kind === 'github'
        ? (
            (await getJson(
              ctx,
              `https://api.github.com/search/issues?per_page=${PAGE}&q=${encodeURIComponent(
                `repo:${host.owner}/${host.repo} is:pr is:merged label:"${label.replace(/"/g, '')}"`,
              )}`,
            )) as { items?: Array<{ number: number }> }
          ).items?.map((i) => i.number) ?? []
        : (
            (await getJson(
              ctx,
              `${gitlabApi(host)}/merge_requests?state=merged&per_page=${PAGE}&labels=${encodeURIComponent(label)}`,
            )) as Array<{ iid: number }>
          ).map((m) => m.iid);
    for (const n of numbers) out.set(n, [...(out.get(n) ?? []), label]);
  }
  return out;
}

/** The commit a branch points at, when the archive did not say. */
export async function resolveHeadSha(ctx: ConnectorContext, branch: string): Promise<string | null> {
  const host = supportedHost(ctx);
  try {
    if (host.kind === 'github') {
      const body = (await getJson(ctx, `${githubApi(host)}/commits/${encodeURIComponent(branch)}`)) as { sha?: string };
      return body.sha ?? null;
    }
    const body = (await getJson(ctx, `${gitlabApi(host)}/repository/commits/${encodeURIComponent(branch)}`)) as {
      id?: string;
    };
    return body.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The pull / merge request a commit landed through, read from its message:
 * GitHub's squash `subject (#12)` and merge `Merge pull request #12 from …`,
 * GitLab's `See merge request group/project!12`.
 */
export function requestNumberOf(message: string, kind: RepoHost['kind']): number | null {
  const subject = message.split('\n')[0] ?? '';
  if (kind === 'gitlab') {
    const m = /See merge request [^\s!]+!(\d+)/.exec(message);
    return m ? Number(m[1]) : null;
  }
  const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

/** Links built from the host and a sha or number — never from a message. */
export function commitUrl(host: RepoHost, sha: string): string {
  return host.kind === 'gitlab'
    ? `${host.origin}/${host.owner}/${host.repo}/-/commit/${sha}`
    : `${host.origin}/${host.owner}/${host.repo}/commit/${sha}`;
}

export function requestUrl(host: RepoHost, n: number): string {
  return host.kind === 'gitlab'
    ? `${host.origin}/${host.owner}/${host.repo}/-/merge_requests/${n}`
    : `${host.origin}/${host.owner}/${host.repo}/pull/${n}`;
}

export function compareUrl(host: RepoHost, base: string, head: string): string {
  return host.kind === 'gitlab'
    ? `${host.origin}/${host.owner}/${host.repo}/-/compare/${base}...${head}`
    : `${host.origin}/${host.owner}/${host.repo}/compare/${base}...${head}`;
}

/**
 * Newest release first. Tags are compared by their numbers (`v1.10.0` after
 * `v1.9.0`), and a pre-release (`v2.0.0-rc.1`) sorts below its release.
 */
export function sortTagsByVersion<T extends { name: string }>(tags: T[]): T[] {
  const key = (name: string) => {
    const [core, pre] = name.replace(/^[^\d]*/, '').split(/-(.*)/s);
    return { nums: (core.match(/\d+/g) ?? []).map(Number), pre: pre ?? null };
  };
  return [...tags].sort((a, b) => {
    const ka = key(a.name);
    const kb = key(b.name);
    for (let i = 0; i < Math.max(ka.nums.length, kb.nums.length); i += 1) {
      const d = (kb.nums[i] ?? 0) - (ka.nums[i] ?? 0);
      if (d !== 0) return d;
    }
    if (ka.pre !== kb.pre) {
      if (ka.pre === null) return -1;
      if (kb.pre === null) return 1;
      return kb.pre.localeCompare(ka.pre, undefined, { numeric: true });
    }
    return b.name.localeCompare(a.name);
  });
}

// --- internals ---

function supportedHost(ctx: ConnectorContext): RepoHost & { kind: 'github' | 'gitlab' } {
  const host = repoHost(ctx);
  if (host.kind === 'other') throw new RepoHistoryUnsupportedError(host.origin);
  return host as RepoHost & { kind: 'github' | 'gitlab' };
}

function githubApi(host: RepoHost): string {
  return `https://api.github.com/repos/${encodeURIComponent(host.owner)}/${encodeURIComponent(host.repo)}`;
}

function gitlabApi(host: RepoHost): string {
  return `${host.origin}/api/v4/projects/${encodeURIComponent(`${host.owner}/${host.repo}`)}`;
}

async function getJson(ctx: ConnectorContext, url: string): Promise<unknown> {
  const host = repoHost(ctx);
  const res = await connectorFetch(
    url,
    { headers: host.kind === 'gitlab' ? gitlabHeaders(ctx) : githubHeaders(ctx), signal: ctx.signal },
    ctx,
  );
  return res.json();
}

async function githubHistory(ctx: ConnectorContext, host: RepoHost, head: string, max: number): Promise<CommitRange> {
  const commits: RepoCommit[] = [];
  let more = true;
  for (let page = 1; commits.length < max && more; page += 1) {
    const rows = (await getJson(
      ctx,
      `${githubApi(host)}/commits?sha=${encodeURIComponent(head)}&per_page=${PAGE}&page=${page}`,
    )) as Array<{ sha: string; commit: { message: string; committer?: { date?: string } } }>;
    commits.push(...rows.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.committer?.date ?? null })));
    more = rows.length === PAGE;
  }
  // The list endpoint is newest first; a range reads oldest first everywhere else.
  const kept = commits.slice(0, max).reverse();
  return { commits: kept, truncated: more || commits.length > max, total: commits.length, files: null };
}

async function gitlabHistory(ctx: ConnectorContext, host: RepoHost, head: string, max: number): Promise<CommitRange> {
  const commits: RepoCommit[] = [];
  let more = true;
  for (let page = 1; commits.length < max && more; page += 1) {
    const rows = (await getJson(
      ctx,
      `${gitlabApi(host)}/repository/commits?ref_name=${encodeURIComponent(head)}&per_page=${PAGE}&page=${page}`,
    )) as Array<{ id: string; message: string; committed_date?: string }>;
    commits.push(...rows.map((c) => ({ sha: c.id, message: c.message, date: c.committed_date ?? null })));
    more = rows.length === PAGE;
  }
  const kept = commits.slice(0, max).reverse();
  return { commits: kept, truncated: more || commits.length > max, total: commits.length, files: null };
}
