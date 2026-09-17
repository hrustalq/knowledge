import { unzipSync } from 'fflate';
import { safeFetch } from '../../common/safe-fetch.js';
import {
  connectorFetch,
  ConnectorRequestError,
  optionalConfig,
  requireConfig,
  trimBaseUrl,
  type ConnectorContext,
} from './connector.types.js';

/**
 * Downloading a git repository, shared by the two adapters that need one
 * (docs/features/27).
 *
 * This is `MarkdownGitAdapter`'s own download lifted out unchanged in substance:
 * fetch the host's zip archive over HTTPS and unzip it with `fflate` rather than
 * shelling out to git — no binary to install, no working copy on disk, and one
 * request instead of a clone.
 *
 * What changed in the lifting is the filter. `markdown-git` discarded every
 * non-`.md` entry *during* the unzip, which was right when markdown was the only
 * consumer; the codebase connector needs the source files that pass discarded.
 * So this returns everything it could read and each adapter filters on the way
 * out, which costs `markdown-git` a little memory on a large repository and is
 * why the size and binary caps below exist at all.
 */

/** Files above this never make the map. A vendored bundle or a checked-in binary is not documentation. */
const MAX_FILE_BYTES = 1_000_000;

/** Whole trees that are never anybody's source: dependencies, build output, VCS metadata. */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage',
]);

export interface RepoArchive {
  /** Repo-relative path -> bytes. The wrapping `<repo>-<ref>/` directory is stripped. */
  files: Map<string, Uint8Array>;
  /** Skipped for size or for being binary — reported so a thin result is explainable. */
  skipped: { oversize: number; binary: number };
  /**
   * The branch actually read, which is not the configured one when Branch was
   * left empty (#28). Carried here so `blobUrl` callers that already await the
   * archive do not have to resolve it a second time.
   */
  branch: string;
}

export interface RepoHost {
  kind: 'github' | 'gitlab' | 'other';
  origin: string;
  owner: string;
  repo: string;
}

export function repoHost(ctx: ConnectorContext): RepoHost {
  const raw = trimBaseUrl(requireConfig(ctx.config, 'repoUrl')).replace(/\.git$/, '');
  const url = new URL(raw);
  const [owner, repo] = url.pathname.replace(/^\/+/, '').split('/');
  if (!owner || !repo) throw new Error('repository URL must look like https://host/owner/repo');
  const kind = url.hostname === 'github.com' ? 'github' : url.hostname.includes('gitlab') ? 'gitlab' : 'other';
  return { kind, origin: url.origin, owner, repo };
}

/**
 * Resolves which branch to read, honouring "empty means the repository's own
 * default" (#28).
 *
 * The Branch field is optional in both connector kinds, and this used to answer
 * the literal string `main` for an empty one — so every repository whose
 * default is `dev` or `master` failed on a configuration that looked complete
 * in the form, with a 404 that named neither the branch nor the reason.
 *
 * Cached per `ctx.config` for the same reason the archive is: one object per
 * connector row per run, so two connectors on one repository do not share and
 * nothing outlives the run. An explicit branch costs no request at all; an
 * empty one costs a single metadata call per run.
 *
 * Falls back to `main` when the probe fails rather than throwing, because the
 * caller is about to make a request that produces a far better error message
 * than "could not determine the default branch" would.
 */
const branchCache = new WeakMap<object, Promise<string>>();

export function resolveBranch(ctx: ConnectorContext): Promise<string> {
  const explicit = optionalConfig(ctx.config, 'branch');
  if (explicit) return Promise.resolve(explicit);

  let pending = branchCache.get(ctx.config);
  if (!pending) {
    pending = defaultBranch(ctx).then((b) => b ?? 'main');
    branchCache.set(ctx.config, pending);
  }
  return pending;
}

/** The repository's own default branch, or null if it could not be read. */
async function defaultBranch(ctx: ConnectorContext): Promise<string | null> {
  const meta = await repoMetadata(ctx);
  return meta?.default_branch ?? null;
}

/**
 * `GET /repos/{owner}/{repo}` (or GitLab's project endpoint), never throwing.
 *
 * Raw `safeFetch` rather than `connectorFetch`, deliberately: a 404 here is a
 * *value* — it is how "no such repository, or the credential cannot see it" is
 * distinguished from "no such branch" — and `connectorFetch` turns every
 * non-2xx into a throw. The same reasoning already applies to the contents
 * probe in `markdown-git.adapter.ts`.
 */
async function repoMetadata(ctx: ConnectorContext): Promise<{ default_branch?: string } | null> {
  const host = repoHost(ctx);
  if (host.kind === 'other') return null;

  const url =
    host.kind === 'gitlab'
      ? `${host.origin}/api/v4/projects/${encodeURIComponent(`${host.owner}/${host.repo}`)}`
      : `https://api.github.com/repos/${encodeURIComponent(host.owner)}/${encodeURIComponent(host.repo)}`;

  try {
    const res = await safeFetch(
      url,
      {
        headers: host.kind === 'gitlab' ? gitlabHeaders(ctx) : githubHeaders(ctx),
        signal: ctx.signal,
      },
      ctx.allowPrivate,
    );
    if (!res.ok) return null;
    return (await res.json()) as { default_branch?: string };
  } catch {
    return null;
  }
}

export function repoSubdir(ctx: ConnectorContext): string {
  return (optionalConfig(ctx.config, 'subdir') ?? '').replace(/^\/+|\/+$/g, '');
}

export function githubHeaders(ctx: ConnectorContext): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'knowledge-connector',
    ...(ctx.credential ? { authorization: `Bearer ${ctx.credential}` } : {}),
  };
}

export function gitlabHeaders(ctx: ConnectorContext): Record<string, string> {
  return ctx.credential ? { 'private-token': ctx.credential } : {};
}

/**
 * Where a path can be read in a browser, for `ExternalRef.url` and frontmatter.
 *
 * The branch is a parameter rather than resolved here, because resolving it is
 * now asynchronous and this is called inside `map()` over every file in a
 * repository. Every caller either holds the branch already (the push path) or
 * has awaited the archive, which carries it.
 */
export function blobUrl(ctx: ConnectorContext, path: string, branch: string): string {
  const host = repoHost(ctx);
  const segment = host.kind === 'gitlab' ? '-/blob' : 'blob';
  return `${host.origin}/${host.owner}/${host.repo}/${segment}/${branch}/${path}`;
}

/**
 * Archive downloads are the expensive step; one per run is plenty.
 *
 * Keyed on the context's `config` object, which is one object per connector row
 * per run — so two connectors pointed at the same repository do not share, and
 * nothing outlives the run that created it.
 */
const cache = new WeakMap<object, Promise<RepoArchive>>();

export function downloadRepoArchive(ctx: ConnectorContext): Promise<RepoArchive> {
  // The *promise* is cached, not the result: `list()` and `fetch()` can both be
  // in flight before either resolves, and caching the result would download the
  // archive twice on exactly the path that matters.
  let pending = cache.get(ctx.config);
  if (!pending) {
    pending = download(ctx);
    cache.set(ctx.config, pending);
  }
  return pending;
}

async function download(ctx: ConnectorContext): Promise<RepoArchive> {
  const host = repoHost(ctx);
  const branch = await resolveBranch(ctx);

  const url =
    host.kind === 'gitlab'
      ? `${host.origin}/${host.owner}/${host.repo}/-/archive/${encodeURIComponent(branch)}/${host.repo}-${branch}.zip`
      : `https://codeload.github.com/${host.owner}/${host.repo}/zip/refs/heads/${encodeURIComponent(branch)}`;

  let res: Response;
  try {
    res = await connectorFetch(
      url,
      {
        headers: host.kind === 'gitlab' ? gitlabHeaders(ctx) : githubHeaders(ctx),
        signal: ctx.signal,
      },
      ctx,
    );
  } catch (err) {
    throw await explain404(ctx, err, branch);
  }
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));

  const files = new Map<string, Uint8Array>();
  const skipped = { oversize: 0, binary: 0 };

  for (const [name, bytes] of Object.entries(zip)) {
    // Archives are wrapped in a single `<repo>-<ref>/` directory.
    const path = name.split('/').slice(1).join('/');
    if (!path || bytes.length === 0) continue;

    const segments = path.split('/');
    if (segments.some((s) => IGNORED_SEGMENTS.has(s))) continue;
    if (bytes.length > MAX_FILE_BYTES) {
      skipped.oversize += 1;
      continue;
    }
    if (isBinary(bytes)) {
      skipped.binary += 1;
      continue;
    }
    files.set(path, bytes);
  }

  ctx.debug('archive', { files: files.size, branch, ...skipped });
  return { files, skipped, branch };
}

/**
 * Turns the archive host's bare 404 into a sentence that names the cause (#28).
 *
 * GitHub answers 404 for three unrelated failures — the repository does not
 * exist, it exists but the credential cannot read it, or the branch is not
 * there — and codeload's body is the string `404: Not Found` in every one of
 * them. Masking "no access" as "not found" is deliberate on GitHub's part, so
 * no amount of reading the response can separate the first two from the third.
 * One extra request can: `GET /repos/{owner}/{repo}` answers 404 when the
 * credential cannot see the repository, and 200 with the real `default_branch`
 * when it can — in which case the branch was the problem all along.
 *
 * The probe runs **only on the failure path**, so a healthy sync still costs
 * exactly one request (plus the default-branch lookup, and only when Branch was
 * left empty).
 *
 * Anything that is not a 404 is rethrown untouched: a 401, a 403 or a 5xx
 * already says what it is.
 */
async function explain404(ctx: ConnectorContext, err: unknown, branch: string): Promise<unknown> {
  if (!(err instanceof ConnectorRequestError) || err.status !== 404) return err;

  const host = repoHost(ctx);
  if (host.kind === 'other') return err;

  const slug = `${host.owner}/${host.repo}`;
  const meta = await repoMetadata(ctx);

  if (!meta) {
    return new Error(
      ctx.credential
        ? `${slug} was not found, or the credential cannot read it — check that the repository exists and that the token or GitHub App installation has read access to it`
        : `${slug} was not found, and no credential is configured — a private repository needs a token or a GitHub App installation with read access`,
    );
  }

  const actual = meta.default_branch;
  return new Error(
    actual
      ? `branch "${branch}" does not exist in ${slug} — its default branch is "${actual}". Leave the Branch field empty to follow the default.`
      : `branch "${branch}" does not exist in ${slug}`,
  );
}

/**
 * A NUL byte in the first few KB. This is `git`'s own heuristic and it is the
 * cheap one: sniffing encodings properly would cost more than re-reading the
 * file, and everything this guards is either source or it is not ours to read.
 */
function isBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 8192);
  return window.includes(0);
}
