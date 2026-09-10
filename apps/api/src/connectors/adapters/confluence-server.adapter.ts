import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { htmlToMarkdown } from '../../import/parsers/html-to-markdown.js';
import { t } from '../../i18n/t.js';
import { countMacros, safeJson, verifyHubSignature } from './confluence.adapter.js';
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
 * Confluence Server / Data Center (docs/features/19).
 *
 * The same product name as `ConfluenceAdapter` and almost none of the same API.
 * Server/DC has no `/api/v2` whatsoever — `/rest/api/*` (v1) is all there is —
 * addresses spaces by **key** rather than by the numeric id v2 introduced, pages
 * with `start`/`limit` offsets rather than an opaque cursor, and authenticates a
 * Personal Access Token as `Bearer` where Cloud wants `email:api-token` over
 * Basic. Hence a second adapter rather than branches through the first: five of
 * its six methods would have been a conditional.
 *
 * What genuinely is shared is imported, not copied: storage format is identical
 * in both products, so `htmlToMarkdown`, `markdownToStorageFormat` and
 * `countMacros` all apply unchanged, as does the `x-hub-signature` webhook
 * convention.
 *
 * A note for whoever debugs a `ConnectorNetworkError` here: self-hosted
 * instances very often serve an incomplete certificate chain. Browsers and curl
 * paper over that by fetching the missing intermediate from the leaf's AIA
 * extension; Node does not, and reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The
 * fix is the deployment's `NODE_EXTRA_CA_CERTS`, deliberately not a
 * per-connector "skip TLS checks" toggle — that would disable verification for
 * a tenant-supplied URL.
 */
@Injectable()
export class ConfluenceServerAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'confluence-server';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: true, webhook: true };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const space = await this.space(ctx);
    return { ok: true, detail: `${space.name} (${space.key})` };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const base = this.base(ctx);
    const key = requireConfig(ctx.config, 'spaceKey');
    let start = 0;

    for (;;) {
      const url = new URL(`${base}/rest/api/content`);
      url.searchParams.set('spaceKey', key);
      url.searchParams.set('type', 'page');
      url.searchParams.set('status', 'current');
      url.searchParams.set('expand', 'version');
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('start', String(start));

      const body = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal })
      ).json()) as ServerList<ServerContent>;

      const results = body.results ?? [];
      for (const page of results) {
        yield {
          externalId: page.id,
          title: page.title,
          url: this.pageUrl(base, page.id),
          version: page.version ? String(page.version.number) : undefined,
        };
      }

      // v1 offers `_links.next`, but only sometimes and relative to a separate
      // `_links.base`. A short page is the unambiguous end of the collection.
      if (results.length < PAGE_SIZE) return;
      start += results.length;
    }
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const base = this.base(ctx);
    const url = `${base}/rest/api/content/${encodeURIComponent(ref.externalId)}?expand=body.storage,version`;
    const page = (await (
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal })
    ).json()) as ServerContent;

    const storage = page.body?.storage?.value ?? '';
    const warnings: string[] = [];

    // Counted before conversion for the reason the Cloud adapter states: a page
    // whose whole body was a macro must not arrive blank with nothing said.
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
    const key = requireConfig(ctx.config, 'spaceKey');
    const value = markdownToStorageFormat(doc.markdown);
    const headers = { ...this.headers(ctx), 'content-type': 'application/json' };

    if (!doc.ref) {
      const created = (await (
        await connectorFetch(`${base}/rest/api/content`, {
          method: 'POST',
          headers,
          signal: ctx.signal,
          body: JSON.stringify({
            type: 'page',
            title: doc.title,
            space: { key },
            body: { storage: { value, representation: 'storage' } },
          }),
        })
      ).json()) as ServerContent;
      return {
        externalId: created.id,
        title: created.title,
        url: this.pageUrl(base, created.id),
        version: created.version ? String(created.version.number) : '1',
      };
    }

    // Same optimistic rule as Cloud — the new version must be exactly one past
    // the current — so it is re-read rather than derived from the link, which
    // may be stale if someone edited between our pull and this push.
    const id = encodeURIComponent(doc.ref.externalId);
    const current = (await (
      await connectorFetch(`${base}/rest/api/content/${id}?expand=version`, {
        headers: this.headers(ctx),
        signal: ctx.signal,
      })
    ).json()) as ServerContent;
    const next = (current.version?.number ?? 0) + 1;

    const updated = (await (
      await connectorFetch(`${base}/rest/api/content/${id}`, {
        method: 'PUT',
        headers,
        signal: ctx.signal,
        body: JSON.stringify({
          id: doc.ref.externalId,
          type: 'page',
          title: doc.title,
          space: { key },
          body: { storage: { value, representation: 'storage' } },
          version: { number: next, message: t('connector.pushVersionMessage') },
        }),
      })
    ).json()) as ServerContent;

    return {
      externalId: updated.id,
      title: updated.title,
      url: this.pageUrl(base, updated.id),
      version: String(updated.version?.number ?? next),
    };
  }

  /**
   * Server/DC webhooks carry the same `x-hub-signature` HMAC and the same
   * `{ page: { id } }` payload shape as Cloud, so this is the Cloud check.
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
    // A Server/DC PAT is a bearer token. Sending it as Basic — which is what the
    // Cloud adapter does with `email:api-token` — authenticates as nobody, and
    // Confluence answers 200 with an anonymous view rather than 401, so the
    // failure would surface as an empty space rather than as a credential error.
    return {
      authorization: `Bearer ${ctx.credential ?? ''}`,
      accept: 'application/json',
    };
  }

  private pageUrl(base: string, id: string): string {
    // Stable across renames, unlike the `/display/SPACE/Page+Title` webui link.
    return `${base}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
  }

  private async space(ctx: ConnectorContext): Promise<{ key: string; name: string }> {
    const base = this.base(ctx);
    const key = requireConfig(ctx.config, 'spaceKey');
    const url = `${base}/rest/api/space?spaceKey=${encodeURIComponent(key)}&limit=1`;
    const body = (await (
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal })
    ).json()) as ServerList<{ key: string; name: string }>;
    const space = body.results?.[0];
    // v1 answers 200 with an empty list for a space that does not exist *and*
    // for one this token cannot see, so the message has to cover both.
    if (!space) throw new Error(`space ${key} not found, or not visible to this token`);
    return space;
  }
}

// --- upstream shapes (only the fields actually read) ---

interface ServerList<T> {
  results?: T[];
  size?: number;
  start?: number;
  limit?: number;
}
interface ServerContent {
  id: string;
  title: string;
  version?: { number: number };
  body?: { storage?: { value?: string } };
}
