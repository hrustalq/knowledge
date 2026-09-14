import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import matter from 'gray-matter';
import { safeJson, verifyHubSignature } from './confluence.adapter.js';
import { safeFetch } from '../../common/safe-fetch.js';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import {
  connectorFetch,
  optionalConfig,
  requireConfig,
  trimBaseUrl,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
  type OutboundDocument,
} from './connector.types.js';

/**
 * Markdown in a git repository (docs/features/19).
 *
 * This is the adapter that covers an Obsidian vault, an mkdocs site or a
 * Docusaurus `docs/` folder: Obsidian has no server API, and a vault is exactly
 * a folder of markdown files, so there is nothing else to integrate with.
 *
 * Pull downloads the repository archive over HTTPS and unzips it with `fflate`
 * (already a dependency, used by the pptx parser) rather than shelling out to
 * git: no binary to install, no working copy to keep on disk, and one request
 * instead of a clone. `externalId` is the repo-relative path, which is stable
 * across commits and is what makes a re-sync land on the same page.
 *
 * Push needs a host API, so it works for GitHub and GitLab and reports itself
 * unavailable elsewhere.
 */
@Injectable()
export class MarkdownGitAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'markdown-git';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: true, webhook: true, tree: false };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const files = await this.download(ctx);
    const host = this.host(ctx);
    const pushable = host.kind === 'github' || host.kind === 'gitlab';
    return {
      ok: true,
      detail: `${files.size} markdown file(s)${pushable ? '' : ' — this host is pull-only'}`,
    };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const files = await this.download(ctx);
    for (const [path, bytes] of files) {
      yield {
        externalId: path,
        title: titleFor(path, bytes),
        url: this.blobUrl(ctx, path),
        // No per-file sha without an extra API call, so the content hash is the
        // version. It is exactly as good for change detection and costs nothing.
        version: hashBytes(bytes),
      };
    }
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const files = await this.download(ctx);
    const bytes = files.get(ref.externalId);
    if (!bytes) throw new Error(`${ref.externalId} is no longer in the repository`);

    const raw = Buffer.from(bytes).toString('utf8');
    const parsed = matter(raw);
    const warnings: string[] = [];

    // Obsidian wiki-links resolve inside a vault and nowhere else. They are left
    // as written — rewriting them to page ids would need the whole vault
    // imported first — but the reader is told they will not resolve.
    const wikiLinks = raw.match(/\[\[[^\]]+\]\]/g);
    if (wikiLinks?.length) {
      warnings.push(
        `${wikiLinks.length} wiki-style [[link]](s) were kept as text — they point inside the source vault.`,
      );
    }

    return {
      ref,
      title: (typeof parsed.data.title === 'string' && parsed.data.title) || titleFor(ref.externalId, bytes),
      markdown: parsed.content.trim(),
      frontmatter: { ...parsed.data, source: this.blobUrl(ctx, ref.externalId) },
      warnings,
    };
  }

  async push(ctx: ConnectorContext, doc: OutboundDocument): Promise<ExternalRef> {
    const host = this.host(ctx);
    const branch = optionalConfig(ctx.config, 'branch') ?? 'main';
    const path = doc.ref?.externalId ?? this.pathFor(ctx, doc.title);
    const content = Buffer.from(doc.markdown, 'utf8').toString('base64');
    const message = `Update ${path} from the knowledge base`;

    if (host.kind === 'github') {
      const api = `https://api.github.com/repos/${host.owner}/${host.repo}/contents/${encodePath(path)}`;
      // GitHub's contents API needs the blob sha to update; its absence means create.
      // safeFetch rather than bare fetch: this probe dials a user-configured
      // host like every other call here, and was the one that skipped the guard.
      const existing = await safeFetch(
        `${api}?ref=${encodeURIComponent(branch)}`,
        { headers: this.githubHeaders(ctx), signal: ctx.signal },
        ctx.allowPrivate,
      );
      const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;

      const res = (await (
        await connectorFetch(api, {
          method: 'PUT',
          headers: { ...this.githubHeaders(ctx), 'content-type': 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) }),
        }, ctx)
      ).json()) as { content?: { sha?: string; html_url?: string } };

      return {
        externalId: path,
        title: doc.title,
        url: res.content?.html_url ?? this.blobUrl(ctx, path),
        version: res.content?.sha,
      };
    }

    if (host.kind === 'gitlab') {
      const project = encodeURIComponent(`${host.owner}/${host.repo}`);
      const api = `${host.origin}/api/v4/projects/${project}/repository/files/${encodeURIComponent(path)}`;
      const body = JSON.stringify({ branch, content: doc.markdown, commit_message: message });
      const headers = { ...this.gitlabHeaders(ctx), 'content-type': 'application/json' };

      // GitLab separates create from update by verb, and answers 400 when a
      // create collides — so update first and fall back to create.
      const updated = await safeFetch(
        api,
        { method: 'PUT', headers, signal: ctx.signal, body },
        ctx.allowPrivate,
      );
      if (!updated.ok) {
        await connectorFetch(api, { method: 'POST', headers, signal: ctx.signal, body }, ctx);
      }
      return { externalId: path, title: doc.title, url: this.blobUrl(ctx, path) };
    }

    throw new Error('only GitHub and GitLab repositories can be published to');
  }

  verifyWebhook(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): ExternalRef[] | null {
    const secret = ctx.webhookSecret;
    if (!secret) return null;

    // GitLab sends a plain shared token; GitHub signs the body.
    const gitlabToken = headers['x-gitlab-token'];
    if (gitlabToken !== undefined) {
      if (gitlabToken !== secret) return null;
    } else if (!verifyHubSignature(headers, rawBody, secret)) {
      return null;
    }

    const payload = safeJson(rawBody);
    const commits = (payload?.commits ?? []) as Array<{
      added?: string[];
      modified?: string[];
      removed?: string[];
    }>;
    const paths = new Set<string>();
    for (const commit of commits) {
      for (const p of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
        if (p.toLowerCase().endsWith('.md')) paths.add(p);
      }
    }
    return [...paths].map((p) => ({ externalId: p, title: p }));
  }

  // --- internals ---

  /** Archive downloads are the expensive step; one per run is plenty. */
  private cache = new WeakMap<object, Map<string, Uint8Array>>();

  private async download(ctx: ConnectorContext): Promise<Map<string, Uint8Array>> {
    const cached = this.cache.get(ctx.config);
    if (cached) return cached;

    const host = this.host(ctx);
    const branch = optionalConfig(ctx.config, 'branch') ?? 'main';
    const subdir = (optionalConfig(ctx.config, 'subdir') ?? '').replace(/^\/+|\/+$/g, '');

    const url =
      host.kind === 'gitlab'
        ? `${host.origin}/${host.owner}/${host.repo}/-/archive/${encodeURIComponent(branch)}/${host.repo}-${branch}.zip`
        : `https://codeload.github.com/${host.owner}/${host.repo}/zip/refs/heads/${encodeURIComponent(branch)}`;

    const res = await connectorFetch(
      url,
      {
        headers: host.kind === 'gitlab' ? this.gitlabHeaders(ctx) : this.githubHeaders(ctx),
        signal: ctx.signal,
      },
      ctx,
    );
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));

    const files = new Map<string, Uint8Array>();
    for (const [name, bytes] of Object.entries(zip)) {
      if (!name.toLowerCase().endsWith('.md') || bytes.length === 0) continue;
      // Archives are wrapped in a single `<repo>-<ref>/` directory.
      const path = name.split('/').slice(1).join('/');
      if (!path) continue;
      if (subdir && !path.startsWith(`${subdir}/`)) continue;
      files.set(path, bytes);
    }

    this.cache.set(ctx.config, files);
    return files;
  }

  private host(ctx: ConnectorContext): {
    kind: 'github' | 'gitlab' | 'other';
    origin: string;
    owner: string;
    repo: string;
  } {
    const raw = trimBaseUrl(requireConfig(ctx.config, 'repoUrl')).replace(/\.git$/, '');
    const url = new URL(raw);
    const [owner, repo] = url.pathname.replace(/^\/+/, '').split('/');
    if (!owner || !repo) throw new Error('repository URL must look like https://host/owner/repo');
    const kind =
      url.hostname === 'github.com' ? 'github' : url.hostname.includes('gitlab') ? 'gitlab' : 'other';
    return { kind, origin: url.origin, owner, repo };
  }

  private blobUrl(ctx: ConnectorContext, path: string): string {
    const host = this.host(ctx);
    const branch = optionalConfig(ctx.config, 'branch') ?? 'main';
    const segment = host.kind === 'gitlab' ? '-/blob' : 'blob';
    return `${host.origin}/${host.owner}/${host.repo}/${segment}/${branch}/${path}`;
  }

  private pathFor(ctx: ConnectorContext, title: string): string {
    const subdir = (optionalConfig(ctx.config, 'subdir') ?? '').replace(/^\/+|\/+$/g, '');
    const slug =
      title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'untitled';
    return subdir ? `${subdir}/${slug}.md` : `${slug}.md`;
  }

  private githubHeaders(ctx: ConnectorContext): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'user-agent': 'knowledge-connector',
      ...(ctx.credential ? { authorization: `Bearer ${ctx.credential}` } : {}),
    };
  }

  private gitlabHeaders(ctx: ConnectorContext): Record<string, string> {
    return ctx.credential ? { 'private-token': ctx.credential } : {};
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * The first `# heading`, else the filename. Frontmatter is skipped by hand
 * rather than with gray-matter: this reads a truncated prefix of the file, and
 * a half-delimited block would make the parser throw on a file that is fine.
 */
function titleFor(path: string, bytes: Uint8Array): string {
  let text = Buffer.from(bytes.subarray(0, 4096)).toString('utf8');
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) text = text.slice(end + 4);
  }
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading) return heading[1].trim();
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}
