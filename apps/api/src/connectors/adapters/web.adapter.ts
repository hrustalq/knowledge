import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { load as parseYaml } from 'js-yaml';
import { webCrawls, type ApiSpecKind, type ApiSpecSyntax, type ConnectorCapabilities, type ConnectorKind } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { extractSource, isHtmlBody, isMarkdownBody } from '../source-recipe.js';
import { crawlScope, foldUrl, inScope, pageLinks, pathParents, sitemapLocs } from '../web-crawl.js';
import { verifyHubSignature } from '../webhook-payload.js';
import { specKindOf } from './repo-specs.js';
import { retryAfterMs } from './web-failures.js';
import {
  ConnectorRequestError,
  connectorFetch,
  requireConfig,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
} from './connector.types.js';

/** Sent on every source fetch, so a host can see who is reading it and why. */
export const WEB_SOURCE_USER_AGENT = 'KnowledgePlatform-SourceSync/1.0 (+source-backed pages)';
const TIMEOUT_MS = 30_000;
/** A page body larger than this is not a page (5 MB). */
const MAX_BYTES = 5 * 1024 * 1024;
/** One request at a time per host, this far apart (#674, phase 3). */
export const SOURCE_CRAWL_GAP_MS = 1_000;
/** The longest a `Retry-After` holds a host's queue inside a crawl; the item's own retry covers the rest. */
const MAX_HOST_WAIT_MS = 60_000;
/** Sitemaps read per crawl, the index included. */
const MAX_SITEMAPS = 10;
/** A page discovery read, kept for staging's fetch of the same page within this long. */
const PREFETCH_TTL_MS = 30 * 60_000;
/** Characters of prefetched bodies held at once, across every crawl in this process. */
const PREFETCH_MAX_CHARS = 64 * 1024 * 1024;

/**
 * A `web` source (#674, phase 1): one URL whose page here is read-only and
 * replaced by each new version.
 *
 * Markdown passes through; HTML goes through the implicit extraction recipe
 * (article scoring, `source-recipe.ts`). The fetched body rides along on
 * `source`, and staging re-reads it through the page's own recipe (phase 2).
 *
 * Every fetch is conditional on the validators the link last agreed on
 * (`ref.knownVersion`), so an unchanged source costs a 304 and nothing else.
 * Transient failures throw; the staging step decides when to try again.
 */
@Injectable()
export class WebAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'web';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: false, webhook: true, tree: false };
  /** Settable so a test need not wait out the politeness gap. */
  gapMs = SOURCE_CRAWL_GAP_MS;
  private readonly hostQueue = new Map<string, Promise<unknown>>();
  private readonly hostFreeAt = new Map<string, number>();
  private readonly prefetched = new Map<string, { doc: ExternalDocument; at: number }>();
  private prefetchedChars = 0;

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const url = requireConfig(ctx.config, 'url');
    const doc = await this.fetch(ctx, { externalId: url, title: url, url });
    return { ok: true, detail: doc.title };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const url = requireConfig(ctx.config, 'url');
    yield { externalId: url, title: titleFromUrl(url), url };
  }

  /**
   * The crawl (phase 3). The root is the connector's URL; a page's children
   * are the in-scope links it names — `sitemap.xml` too, for the root — each
   * read once per run however many pages link to it (discovery dedupes by id).
   * A single-URL source has the root and nothing under it.
   *
   * Reading a page for its links is the same request staging would make for
   * its content, so the result is kept for that fetch (`prefetched`). A page
   * that cannot be read yields no children and fails on its own in staging;
   * only the root failing fails the walk, which is what keeps a broken crawl
   * from counting every page as dropped.
   */
  async *children(ctx: ConnectorContext, parent: ExternalRef | null): AsyncIterable<ExternalRef> {
    const root = requireConfig(ctx.config, 'url');
    const crawls = webCrawls(ctx.config);
    if (!parent) {
      yield { externalId: root, title: titleFromUrl(root), url: root, hasChildren: crawls };
      return;
    }
    if (!crawls) return;

    const isRoot = parent.externalId === root;
    let doc: ExternalDocument;
    try {
      doc = await this.read(ctx, { externalId: parent.externalId, title: parent.title, url: parent.url ?? parent.externalId });
    } catch (err) {
      if (isRoot) throw err;
      ctx.debug('crawl: page unreadable, no children', { error: (err as Error).message });
      return;
    }
    this.keep(ctx, doc);

    const scope = crawlScope(root);
    const self = new Set([root, foldUrl(root), parent.externalId]);
    const urls = doc.source ? pageLinks(doc.source) : [];
    if (isRoot) urls.push(...(await this.sitemap(ctx, scope.origin)));
    for (const url of new Set(urls)) {
      if (self.has(url) || !inScope(url, scope)) continue;
      yield { externalId: url, title: titleFromUrl(url), url, parentExternalId: parent.externalId, hasChildren: true };
    }
  }

  /** Crawled pages hang by URL path, not by whichever page linked to them first. */
  nest(ctx: ConnectorContext, externalIds: string[]): Map<string, string | null> {
    return pathParents(requireConfig(ctx.config, 'url'), externalIds);
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const kept = this.take(ctx, ref.externalId);
    if (kept) return { ...kept, ref: { ...ref, ...(kept.ref.version ? { version: kept.ref.version } : {}), url: kept.ref.url ?? ref.url } };
    return this.read(ctx, ref);
  }

  private read(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    return this.polite(ctx, ref.url ?? ref.externalId, () => this.request(ctx, ref));
  }

  /** One request at a time per host, after the gap behind the previous one. */
  private polite<T>(ctx: ConnectorContext, url: string, call: () => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    const turn = (this.hostQueue.get(host) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.hostFreeAt.get(host) ?? 0) - Date.now();
        if (wait > 0) await sleep(wait, undefined, ctx.signal ? { signal: ctx.signal } : undefined);
        try {
          return await call();
        } catch (err) {
          // A 429/503 slows the whole host down, not just the next sync of this page.
          const after = Math.min(retryAfterMs(err), MAX_HOST_WAIT_MS);
          if (after > 0) this.hostFreeAt.set(host, Date.now() + after);
          throw err;
        } finally {
          this.hostFreeAt.set(host, Math.max(this.hostFreeAt.get(host) ?? 0, Date.now() + this.gapMs));
        }
      });
    this.hostQueue.set(host, turn);
    const clear = (): void => {
      if (this.hostQueue.get(host) === turn) this.hostQueue.delete(host);
    };
    turn.then(clear, clear);
    return turn;
  }

  /** `/sitemap.xml` at the origin and the sitemaps an index names, read for their in-scope pages. Missing is fine. */
  private async sitemap(ctx: ConnectorContext, origin: string): Promise<string[]> {
    const pending = [`${origin}/sitemap.xml`];
    const pages: string[] = [];
    for (let read = 0; pending.length > 0 && read < MAX_SITEMAPS; read += 1) {
      const url = pending.shift()!;
      let xml: string;
      try {
        xml = await this.polite(ctx, url, async () => {
          const headers = { accept: 'application/xml, text/xml', 'user-agent': WEB_SOURCE_USER_AGENT, ...credentialHeaders(ctx.credential) };
          const res = await connectorFetch(url, { headers, signal: this.signal(ctx), redirect: 'follow' }, ctx);
          return (await res.text()).slice(0, MAX_BYTES);
        });
      } catch {
        continue;
      }
      for (const loc of sitemapLocs(xml)) {
        if (/\.xml$/i.test(new URL(loc, origin).pathname)) pending.push(loc);
        else pages.push(foldUrl(loc) ?? '');
      }
    }
    return pages.filter(Boolean);
  }

  private keep(ctx: ConnectorContext, doc: ExternalDocument): void {
    const now = Date.now();
    for (const [key, entry] of this.prefetched) {
      if (now - entry.at < PREFETCH_TTL_MS) break; // insertion order is age order
      this.drop(key);
    }
    const chars = doc.source?.body.length ?? doc.markdown.length;
    // ponytail: one in-process cache with a char budget; a crawl over budget just fetches twice.
    if (this.prefetchedChars + chars > PREFETCH_MAX_CHARS) return;
    const key = `${ctx.connectorId}\n${doc.ref.externalId}`;
    this.drop(key);
    this.prefetched.set(key, { doc, at: now });
    this.prefetchedChars += chars;
  }

  private take(ctx: ConnectorContext, externalId: string): ExternalDocument | null {
    const key = `${ctx.connectorId}\n${externalId}`;
    const entry = this.prefetched.get(key);
    this.drop(key);
    return entry && Date.now() - entry.at < PREFETCH_TTL_MS ? entry.doc : null;
  }

  private drop(key: string): void {
    const entry = this.prefetched.get(key);
    if (!entry) return;
    this.prefetched.delete(key);
    this.prefetchedChars -= entry.doc.source?.body.length ?? entry.doc.markdown.length;
  }

  private async request(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const url = ref.url ?? ref.externalId;
    const known = readValidators(ref.knownVersion);
    const headers: Record<string, string> = {
      accept: 'text/markdown, text/x-markdown, text/html;q=0.9, application/json;q=0.8, application/yaml;q=0.8, text/plain;q=0.8',
      'user-agent': WEB_SOURCE_USER_AGENT,
      ...(known.etag ? { 'if-none-match': known.etag } : {}),
      ...(known.lastModified ? { 'if-modified-since': known.lastModified } : {}),
      ...credentialHeaders(ctx.credential),
    };
    let res: Response;
    try {
      res = await connectorFetch(url, { headers, signal: this.signal(ctx), redirect: 'follow' }, ctx);
    } catch (err) {
      if (err instanceof ConnectorRequestError && err.status === 304) {
        return { ref: { ...ref, version: ref.knownVersion }, title: ref.title, markdown: '', notModified: true, warnings: [] };
      }
      throw err;
    }

    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new Error(t('error.source.tooLarge', { mb: MAX_BYTES / 1024 / 1024 }));
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error(t('error.source.tooLarge', { mb: MAX_BYTES / 1024 / 1024 }));

    const version = writeValidators(res.headers.get('etag'), res.headers.get('last-modified'));
    const nextRef: ExternalRef = { ...ref, url, ...(version ? { version } : {}) };
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

    // An OpenAPI/AsyncAPI document (phase 4): stored as written, never through a recipe, so no `source`.
    const spec = readSpec(body, type, url);
    if (spec) return { ref: nextRef, title: spec.title ?? titleFromUrl(url), markdown: body, spec: { kind: spec.kind, syntax: spec.syntax }, warnings: [] };

    const source = { body, contentType: type, url: res.url || url };
    if (isMarkdownBody(type, url)) {
      return { ref: nextRef, title: markdownTitle(body) ?? titleFromUrl(url), markdown: body, warnings: [], source };
    }
    if (isHtmlBody(type)) {
      // The implicit recipe; staging re-reads `source` through the page's own when it has one.
      const article = await extractSource(source, null);
      const warnings = article.contentFound ? [] : [t('connector.warning.sourceNoArticle')];
      return { ref: nextRef, title: article.title ?? titleFromUrl(url), markdown: article.markdown, warnings, source };
    }
    throw new UnsupportedSourceError(type || 'unknown');
  }

  private signal(ctx: ConnectorContext): AbortSignal {
    return ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  }

  /** `X-Hub-Signature-256: sha256=<hex>` over the raw body: any delivery means "check now". */
  verifyWebhook(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): ExternalRef[] | null {
    if (!ctx.webhookSecret || !verifyHubSignature(headers, rawBody, ctx.webhookSecret)) return null;
    const url = requireConfig(ctx.config, 'url');
    return [{ externalId: url, title: titleFromUrl(url), url }];
  }
}

/** A source that is neither markdown nor HTML: a parse failure, never retried. */
export class UnsupportedSourceError extends Error {
  constructor(readonly contentType: string) {
    super(t('error.source.unsupportedType', { type: contentType }));
    this.name = 'UnsupportedSourceError';
  }
}

/**
 * The credential as request headers. `Header-Name: value` sends that header;
 * anything else is a bearer token.
 */
export function credentialHeaders(credential: string | null): Record<string, string> {
  if (!credential) return {};
  const header = /^([A-Za-z0-9-]+):\s*(\S.*)$/.exec(credential.trim());
  return header ? { [header[1]!.toLowerCase()]: header[2]! } : { authorization: `Bearer ${credential.trim()}` };
}

/**
 * The spec a body is, by its top-level key (`specKindOf`), when it is served as
 * JSON or YAML, or as text under a `.json` / `.yaml` / `.yml` path. Anything
 * else — a JSON body that is not a spec included — is not one.
 */
export function readSpec(
  body: string,
  contentType: string,
  url: string,
): { kind: ApiSpecKind; syntax: ApiSpecSyntax; title: string | null } | null {
  const path = new URL(url).pathname.toLowerCase();
  const typed = /[/+](json|yaml|x-yaml)$/.test(contentType);
  const named = /\.(json|ya?ml)$/.test(path) && (contentType === 'text/plain' || contentType === 'application/octet-stream' || contentType === '');
  if (!typed && !named) return null;
  let value: unknown;
  try {
    value = parseYaml(body); // JSON is YAML
  } catch {
    return null;
  }
  const kind = specKindOf(value);
  if (!kind) return null;
  const syntax: ApiSpecSyntax = /json$/.test(contentType) || path.endsWith('.json') || body.trimStart().startsWith('{') ? 'json' : 'yaml';
  const info = (value as { info?: { title?: unknown } }).info;
  const title = typeof info?.title === 'string' && info.title.trim() ? info.title.trim().slice(0, 200) : null;
  return { kind, syntax, title };
}

/** ETag and Last-Modified, as one link version. */
function writeValidators(etag: string | null, lastModified: string | null): string | undefined {
  return etag || lastModified ? JSON.stringify({ etag: etag ?? undefined, lastModified: lastModified ?? undefined }) : undefined;
}

function readValidators(version: string | undefined): { etag?: string; lastModified?: string } {
  if (!version) return {};
  try {
    const parsed = JSON.parse(version) as { etag?: unknown; lastModified?: unknown };
    return {
      ...(typeof parsed.etag === 'string' ? { etag: parsed.etag } : {}),
      ...(typeof parsed.lastModified === 'string' ? { lastModified: parsed.lastModified } : {}),
    };
  } catch {
    return {};
  }
}

function markdownTitle(markdown: string): string | undefined {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown.replace(/^---\n[\s\S]*?\n---\n/, ''));
  return heading?.[1]?.slice(0, 200);
}

/** The last path segment, prettified, else the host. */
export function titleFromUrl(url: string): string {
  const parsed = new URL(url);
  const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
  const name = last.replace(/\.(md|markdown|mdx|html?)$/i, '').replace(/[-_]+/g, ' ').trim();
  return name || parsed.host;
}
