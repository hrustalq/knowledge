import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { htmlToMarkdown } from '../../import/parsers/html-to-markdown.js';
import { t } from '../../i18n/t.js';
import { markdownToStorageFormat } from './markdown-to-html.js';
import { safeJson, verifyHubSignature } from '../webhook-payload.js';
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
  readonly capabilities: ConnectorCapabilities = { pull: true, push: true, webhook: true, tree: true };

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
      // Without this the list omits `version`, so the "far side says nothing
      // changed" skip can never fire and every page is re-fetched on every run.
      url.searchParams.set('body-format', 'none');
      if (cursor) url.searchParams.set('cursor', cursor);

      const body = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as ConfluenceList<ConfluencePage>;

      const results = body.results ?? [];
      ctx.debug('list page', { count: results.length, cursor: cursor ? 'yes' : 'first' });
      for (const page of results) yield this.toRef(base, page);
      cursor = nextCursor(body);
    } while (cursor);
  }

  /**
   * One level of the page tree (docs/features/26).
   *
   * v2 carries `parentId` on every page, so roots are found by listing the space
   * once and keeping the pages that have none — cheaper and more honest than
   * assuming the space homepage is the only root, which is untrue of any space
   * someone has reorganised.
   */
  async *children(ctx: ConnectorContext, parent: ExternalRef | null): AsyncIterable<ExternalRef> {
    const base = this.base(ctx);

    const rootId = optionalConfig(ctx.config, 'rootPageId');
    if (!parent && rootId) {
      const url = `${base}/api/v2/pages/${encodeURIComponent(rootId)}?body-format=none`;
      const page = (await (
        await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as ConfluencePage;
      yield { ...this.toRef(base, page), parentExternalId: undefined, hasChildren: true };
      return;
    }

    if (!parent) {
      for await (const ref of this.list(ctx)) {
        if (!ref.parentExternalId) yield { ...ref, hasChildren: true };
      }
      return;
    }

    let cursor: string | null = null;
    do {
      const url = new URL(`${base}/api/v2/pages/${encodeURIComponent(parent.externalId)}/children`);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (cursor) url.searchParams.set('cursor', cursor);

      const body = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as ConfluenceList<ConfluencePage>;

      const results = body.results ?? [];
      ctx.debug('children', { parent: parent.externalId, count: results.length });
      for (const page of results) {
        yield {
          externalId: page.id,
          title: page.title,
          url: this.pageUrl(base, page.id),
          version: page.version ? String(page.version.number) : undefined,
          parentExternalId: parent.externalId,
          // The children endpoint does not say, so the walk probes: one empty
          // request for a leaf is cheaper than missing a branch.
          hasChildren: true,
        };
      }
      cursor = nextCursor(body);
    } while (cursor);
  }

  private toRef(base: string, page: ConfluencePage): ExternalRef {
    return {
      externalId: page.id,
      title: page.title,
      url: this.pageUrl(base, page.id),
      version: page.version ? String(page.version.number) : undefined,
      ...(page.parentId ? { parentExternalId: String(page.parentId) } : {}),
    };
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const base = this.base(ctx);
    const url = `${base}/api/v2/pages/${encodeURIComponent(ref.externalId)}?body-format=storage`;
    const page = (await (
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal }, ctx)
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
        }, ctx)
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
      }, ctx)
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
      }, ctx)
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
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal }, ctx)
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
  /** v2 carries the parent inline — this is what makes the tree walk possible. */
  parentId?: string | number | null;
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
