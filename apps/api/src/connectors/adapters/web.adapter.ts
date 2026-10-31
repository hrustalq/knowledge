import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { extractArticle } from '../../import/parsers/html-to-markdown.js';
import { verifyHubSignature } from '../webhook-payload.js';
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

/**
 * A `web` source (#674, phase 1): one URL whose page here is read-only and
 * replaced by each new version.
 *
 * Markdown passes through; HTML goes through `extractArticle`, the house
 * answer to "which part of this page is the article" (Defuddle, then the
 * editor's serializer). Extraction recipes replace that in phase 2.
 *
 * Every fetch is conditional on the validators the link last agreed on
 * (`ref.knownVersion`), so an unchanged source costs a 304 and nothing else.
 * Transient failures throw; the staging step decides when to try again.
 */
@Injectable()
export class WebAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'web';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: false, webhook: true, tree: false };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const url = requireConfig(ctx.config, 'url');
    const doc = await this.fetch(ctx, { externalId: url, title: url, url });
    return { ok: true, detail: doc.title };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const url = requireConfig(ctx.config, 'url');
    yield { externalId: url, title: titleFromUrl(url), url };
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const url = ref.url ?? ref.externalId;
    const known = readValidators(ref.knownVersion);
    const headers: Record<string, string> = {
      accept: 'text/markdown, text/x-markdown, text/html;q=0.9, text/plain;q=0.8',
      'user-agent': WEB_SOURCE_USER_AGENT,
      ...(known.etag ? { 'if-none-match': known.etag } : {}),
      ...(known.lastModified ? { 'if-modified-since': known.lastModified } : {}),
      ...credentialHeaders(ctx.credential),
    };
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

    let res: Response;
    try {
      res = await connectorFetch(url, { headers, signal, redirect: 'follow' }, ctx);
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

    if (isMarkdown(type, url)) {
      return { ref: nextRef, title: markdownTitle(body) ?? titleFromUrl(url), markdown: body, warnings: [] };
    }
    if (type === 'text/html' || type === 'application/xhtml+xml') {
      const article = await extractArticle(body, res.url || url);
      const warnings = article.fellBack ? [t('connector.warning.sourceNoArticle')] : [];
      return { ref: nextRef, title: article.title ?? titleFromUrl(url), markdown: article.markdown, warnings };
    }
    throw new UnsupportedSourceError(type || 'unknown');
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

function isMarkdown(type: string, url: string): boolean {
  if (type === 'text/markdown' || type === 'text/x-markdown') return true;
  // Raw file hosts serve `.md` as text/plain (GitHub raw) or with no type.
  const path = new URL(url).pathname.toLowerCase();
  return (type === 'text/plain' || type === 'application/octet-stream' || type === '') && /\.(md|markdown|mdx)$/.test(path);
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
