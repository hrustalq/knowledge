import { unzipSync } from 'fflate';
import {
  connectorFetch,
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

export function repoBranch(ctx: ConnectorContext): string {
  return optionalConfig(ctx.config, 'branch') ?? 'main';
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

/** Where a path can be read in a browser, for `ExternalRef.url` and page frontmatter. */
export function blobUrl(ctx: ConnectorContext, path: string): string {
  const host = repoHost(ctx);
  const segment = host.kind === 'gitlab' ? '-/blob' : 'blob';
  return `${host.origin}/${host.owner}/${host.repo}/${segment}/${repoBranch(ctx)}/${path}`;
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
  const branch = repoBranch(ctx);

  const url =
    host.kind === 'gitlab'
      ? `${host.origin}/${host.owner}/${host.repo}/-/archive/${encodeURIComponent(branch)}/${host.repo}-${branch}.zip`
      : `https://codeload.github.com/${host.owner}/${host.repo}/zip/refs/heads/${encodeURIComponent(branch)}`;

  const res = await connectorFetch(
    url,
    {
      headers: host.kind === 'gitlab' ? gitlabHeaders(ctx) : githubHeaders(ctx),
      signal: ctx.signal,
    },
    ctx,
  );
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

  ctx.debug('archive', { files: files.size, ...skipped });
  return { files, skipped };
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
