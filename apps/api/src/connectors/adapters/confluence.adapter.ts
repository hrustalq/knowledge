import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { htmlToMarkdown } from '../../import/parsers/html-to-markdown.js';
import { t } from '../../i18n/t.js';
import { markdownToStorageFormat } from './markdown-to-html.js';
import {
  connectorFetch,
  requireConfig,
  trimBaseUrl,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
  type OutboundDocument,
} from './connector.types.js';

const PAGE_SIZE = 50;

/**
 * Confluence Cloud (docs/features/19).
 *
 * Pages come back in "storage format" — XHTML — which `htmlToMarkdown` already
 * converts using the same turndown settings the import parsers use, so a pulled
 * page is indistinguishable from markdown the editor wrote and its first local
 * save does not produce a diff full of formatting churn.
 *
 * Credential is `email:api-token` over Basic, which is what Atlassian issues
 * from the account settings page; there is no OAuth app to register.
 */
@Injectable()
export class ConfluenceAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'confluence';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: true, webhook: true };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const spaceKey = requireConfig(ctx.config, 'spaceKey');
    const space = await this.space(ctx);
    return { ok: true, detail: `${space.name} (${spaceKey})` };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const base = this.base(ctx);
    const space = await this.space(ctx);
    let cursor: string | null = null;

    do {
      const url = new URL(`${base}/api/v2/spaces/${space.id}/pages`);
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('status', 'current');
      if (cursor) url.searchParams.set('cursor', cursor);

      const body = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal })
      ).json()) as ConfluenceList<ConfluencePage>;

      for (const page of body.results ?? []) {
        yield {
          externalId: page.id,
          title: page.title,
          url: this.pageUrl(base, page.id),
          version: page.version ? String(page.version.number) : undefined,
        };
      }
      cursor = nextCursor(body);
    } while (cursor);
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const base = this.base(ctx);
    const url = `${base}/api/v2/pages/${encodeURIComponent(ref.externalId)}?body-format=storage`;
    const page = (await (
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal })
    ).json()) as ConfluencePage;

    const storage = page.body?.storage?.value ?? '';
    const warnings: string[] = [];

    // Confluence macros are `<ac:structured-macro>` elements. Turndown drops
    // unknown namespaced tags silently, so they are counted before conversion —
    // a page whose whole body was a Jira-issues macro must not arrive blank
    // with nothing said about it.
    const macros = countMacros(storage);
    if (macros.length > 0) {
      warnings.push(
        t('connector.warning.passthrough', {
          text: `Confluence macros were not carried over: ${macros.join(', ')}.`,
        }),
      );
    }

    return {
      ref: { ...ref, version: page.version ? String(page.version.number) : ref.version },
      title: page.title,
      markdown: htmlToMarkdown(storage),
      frontmatter: { source: this.pageUrl(base, page.id) },
      warnings,
    };
  }

  async push(ctx: ConnectorContext, doc: OutboundDocument): Promise<ExternalRef> {
    const base = this.base(ctx);
    const value = markdownToStorageFormat(doc.markdown);

    if (!doc.ref) {
      const space = await this.space(ctx);
      const created = (await (
        await connectorFetch(`${base}/api/v2/pages`, {
          method: 'POST',
          headers: { ...this.headers(ctx), 'content-type': 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify({
            spaceId: space.id,
            status: 'current',
            title: doc.title,
            body: { representation: 'storage', value },
          }),
        })
      ).json()) as ConfluencePage;
      return {
        externalId: created.id,
        title: created.title,
        url: this.pageUrl(base, created.id),
        version: created.version ? String(created.version.number) : '1',
      };
    }

    // Confluence updates are optimistic: the new version number must be exactly
    // one past the current one, so it is re-read rather than derived from the
    // link (which may be stale if someone edited between our pull and this push).
    const current = (await (
      await connectorFetch(`${base}/api/v2/pages/${encodeURIComponent(doc.ref.externalId)}`, {
        headers: this.headers(ctx),
        signal: ctx.signal,
      })
    ).json()) as ConfluencePage;
    const next = (current.version?.number ?? 0) + 1;

    const updated = (await (
      await connectorFetch(`${base}/api/v2/pages/${encodeURIComponent(doc.ref.externalId)}`, {
        method: 'PUT',
        headers: { ...this.headers(ctx), 'content-type': 'application/json' },
        signal: ctx.signal,
        body: JSON.stringify({
          id: doc.ref.externalId,
          status: 'current',
          title: doc.title,
          body: { representation: 'storage', value },
          version: { number: next, message: t('connector.pushVersionMessage') },
        }),
      })
    ).json()) as ConfluencePage;

    return {
      externalId: updated.id,
      title: updated.title,
      url: this.pageUrl(base, updated.id),
      version: String(updated.version?.number ?? next),
    };
  }

  /**
   * Atlassian signs webhooks with HMAC-SHA256 over the raw body, sent as
   * `x-hub-signature: sha256=<hex>` — the GitHub convention Atlassian adopted.
   */
  verifyWebhook(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): ExternalRef[] | null {
    const secret = ctx.webhookSecret;
    if (!secret || !verifyHubSignature(headers, rawBody, secret)) return null;
    const payload = safeJson(rawBody);
    const id = payload?.page?.id ?? payload?.content?.id;
    if (!id) return [];
    return [{ externalId: String(id), title: String(payload?.page?.title ?? payload?.content?.title ?? '') }];
  }

  private base(ctx: ConnectorContext): string {
    return trimBaseUrl(requireConfig(ctx.config, 'baseUrl'));
  }

  private headers(ctx: ConnectorContext): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(ctx.credential ?? '').toString('base64')}`,
      accept: 'application/json',
    };
  }

  private pageUrl(base: string, id: string): string {
    return `${base}/pages/${id}`;
  }

  private async space(ctx: ConnectorContext): Promise<{ id: string; name: string }> {
    const base = this.base(ctx);
    const key = requireConfig(ctx.config, 'spaceKey');
    const url = `${base}/api/v2/spaces?keys=${encodeURIComponent(key)}&limit=1`;
    const body = (await (
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal })
    ).json()) as ConfluenceList<{ id: string; name: string }>;
    const space = body.results?.[0];
    if (!space) throw new Error(`space ${key} not found`);
    return space;
  }
}

// --- upstream shapes (only the fields actually read) ---

interface ConfluenceList<T> {
  results?: T[];
  _links?: { next?: string };
}
interface ConfluencePage {
  id: string;
  title: string;
  version?: { number: number };
  body?: { storage?: { value?: string } };
}

/** v2 paginates with an opaque cursor buried in `_links.next`. */
function nextCursor(body: ConfluenceList<unknown>): string | null {
  const next = body._links?.next;
  if (!next) return null;
  const match = /[?&]cursor=([^&]+)/.exec(next);
  return match ? decodeURIComponent(match[1]) : null;
}

export function countMacros(storage: string): string[] {
  const names = new Set<string>();
  for (const m of storage.matchAll(/<ac:structured-macro[^>]*ac:name="([^"]+)"/g)) names.add(m[1]);
  return [...names].slice(0, 10);
}

export function verifyHubSignature(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
): boolean {
  const header = headers['x-hub-signature-256'] ?? headers['x-hub-signature'] ?? '';
  const sent = header.replace(/^sha256=/, '');
  if (!sent) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(sent, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safeJson(raw: string): Record<string, any> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}
