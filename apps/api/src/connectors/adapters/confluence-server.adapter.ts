import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { htmlToMarkdown } from '../../import/parsers/html-to-markdown.js';
import { t } from '../../i18n/t.js';
import { countMacros, safeJson, verifyHubSignature } from './confluence.adapter.js';
import { markdownToStorageFormat } from './markdown-to-html.js';
import {
  ConnectorRequestError,
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
  readonly capabilities: ConnectorCapabilities = { pull: true, push: true, webhook: true, tree: true };

  /**
   * Whether this instance answers the bulk page endpoints, decided once per
   * context by the first call that needs them. Older Server builds 404 them, and
   * Forge/OAuth2 apps are barred from the group outright — neither is an error
   * worth surfacing when a universally available fallback exists.
   */
  private readonly bulk = new WeakMap<ConnectorContext, boolean>();

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
      // `ancestors` costs nothing extra here and is what lets the flat path
      // still report hierarchy — both for adapters falling back from the bulk
      // endpoints and for the orphan repair pass after a tree walk.
      url.searchParams.set('expand', 'version,ancestors');
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('start', String(start));

      const body = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as ServerList<ServerContent>;

      const results = body.results ?? [];
      ctx.debug('list page', { start, count: results.length });
      for (const page of results) {
        yield this.toRef(base, page);
      }

      // v1 offers `_links.next`, but only sometimes and relative to a separate
      // `_links.base`. A short page is the unambiguous end of the collection.
      if (results.length < PAGE_SIZE) return;
      start += results.length;
    }
  }

  /**
   * One level of the page tree (docs/features/26).
   *
   * Two routes to the same answer. The bulk group (Confluence 9.3+) is
   * preferred: it is cursor-paginated and returns `hasChildren`, so the walk
   * knows which branches continue without probing each page. Everything else
   * falls back to `child/page`, which has existed since 5.x — and since that
   * route cannot enumerate a space's roots, roots there come from one
   * `expand=ancestors` pass, where a root is a page with no ancestors.
   */
  async *children(ctx: ConnectorContext, parent: ExternalRef | null): AsyncIterable<ExternalRef> {
    const base = this.base(ctx);

    // A configured root page turns the whole space into one subtree.
    const rootId = optionalConfig(ctx.config, 'rootPageId');
    if (!parent && rootId) {
      const url = `${base}/rest/api/content/${encodeURIComponent(rootId)}?expand=version,ancestors`;
      const page = (await (
        await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as ServerContent;
      yield { ...this.toRef(base, page), parentExternalId: undefined, hasChildren: true };
      return;
    }

    if (this.bulk.get(ctx) !== false) {
      try {
        yield* this.bulkChildren(ctx, base, parent);
        return;
      } catch (err) {
        // Only a 404/403 means "this instance does not have the bulk group".
        // A timeout or a real upstream failure must still surface.
        const status = err instanceof ConnectorRequestError ? err.status : 0;
        if (status !== 404 && status !== 403) throw err;
        ctx.debug('bulk page endpoints unavailable, falling back', { status });
        this.bulk.set(ctx, false);
      }
    }

    yield* this.legacyChildren(ctx, base, parent);
  }

  /** Confluence 9.3+ — cursor paginated, carries `hasChildren`. */
  private async *bulkChildren(
    ctx: ConnectorContext,
    base: string,
    parent: ExternalRef | null,
  ): AsyncIterable<ExternalRef> {
    const key = requireConfig(ctx.config, 'spaceKey');
    let cursor: string | null = null;

    do {
      const url = new URL(
        parent
          ? `${base}/rest/api/content/bulk/page/${encodeURIComponent(parent.externalId)}/children`
          : `${base}/rest/api/content/bulk/page/space/${encodeURIComponent(key)}/root`,
      );
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (cursor) url.searchParams.set('cursor', cursor);

      const body = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as ServerBulkList;

      const results = body.results ?? [];
      ctx.debug('children (bulk)', { parent: parent?.externalId ?? 'root', count: results.length });
      for (const page of results) {
        yield {
          externalId: String(page.id),
          title: page.title,
          url: this.pageUrl(base, String(page.id)),
          version: page.version ? String(page.version.number) : undefined,
          ...(parent ? { parentExternalId: parent.externalId } : {}),
          hasChildren: page.hasChildren ?? false,
        };
      }
      cursor = body.nextCursor ?? null;
    } while (cursor);

    this.bulk.set(ctx, true);
  }

  /** Confluence 5.x onwards. No root endpoint, so roots are derived from ancestors. */
  private async *legacyChildren(
    ctx: ConnectorContext,
    base: string,
    parent: ExternalRef | null,
  ): AsyncIterable<ExternalRef> {
    if (!parent) {
      for await (const ref of this.list(ctx)) {
        // A page with no ancestors sits at the top of the space.
        if (!ref.parentExternalId) yield { ...ref, hasChildren: true };
      }
      return;
    }

    let start = 0;
    for (;;) {
      const url = new URL(`${base}/rest/api/content/${encodeURIComponent(parent.externalId)}/child/page`);
      url.searchParams.set('expand', 'version');
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('start', String(start));

      const body = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as ServerList<ServerContent>;

      const results = body.results ?? [];
      ctx.debug('children (legacy)', { parent: parent.externalId, start, count: results.length });
      for (const page of results) {
        yield {
          externalId: page.id,
          title: page.title,
          url: this.pageUrl(base, page.id),
          version: page.version ? String(page.version.number) : undefined,
          parentExternalId: parent.externalId,
          // v1 will not say, so the walk probes: a childless page costs one
          // empty request, which is cheaper than missing a branch.
          hasChildren: true,
        };
      }

      if (results.length < PAGE_SIZE) return;
      start += results.length;
    }
  }

  /** A content row as a ref, with its immediate ancestor as the parent. */
  private toRef(base: string, page: ServerContent): ExternalRef {
    const ancestors = page.ancestors ?? [];
    const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
    return {
      externalId: page.id,
      title: page.title,
      url: this.pageUrl(base, page.id),
      version: page.version ? String(page.version.number) : undefined,
      ...(parent ? { parentExternalId: String(parent.id) } : {}),
    };
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const base = this.base(ctx);
    const url = `${base}/rest/api/content/${encodeURIComponent(ref.externalId)}?expand=body.storage,version`;
    const page = (await (
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal }, ctx)
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
        }, ctx)
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
      }, ctx)
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
      }, ctx)
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
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal }, ctx)
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
  /** Root first, immediate parent last — only present under `expand=ancestors`. */
  ancestors?: Array<{ id: string | number }>;
}
/** The bulk page group (Confluence 9.3+) — keyset paginated, unlike everything else in v1. */
interface ServerBulkList {
  results?: Array<{
    id: string | number;
    title: string;
    version?: { number: number };
    hasChildren?: boolean;
  }>;
  nextCursor?: string | null;
}
