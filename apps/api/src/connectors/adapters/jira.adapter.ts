import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { htmlToMarkdown } from '../../import/parsers/html-to-markdown.js';
import { safeJson, verifyHubSignature } from '../webhook-payload.js';
import {
  connectorFetch,
  requireConfig,
  trimBaseUrl,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
} from './connector.types.js';

const PAGE_SIZE = 50;

/**
 * Jira Cloud (docs/features/19). **Pull only** — `capabilities.push` is false
 * and the optional `push` method is not implemented.
 *
 * Jira stores rich text as Atlassian Document Format, a JSON block tree, not
 * markup. Reading it is easy because the API will render it for us
 * (`expand=renderedFields` returns HTML, which turndown handles like any other
 * page); *writing* it means building ADF by hand, which is its own piece of
 * work and would ship half-supported. The interface's optional `push` is how
 * that is stated, and the UI hides the push controls off `capabilities`.
 */
@Injectable()
export class JiraAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'jira';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: false, webhook: true, tree: false };

  /**
   * A tracker-only connector (no JQL, #424) has nothing to count, so the test
   * is then just that the credential can read the site.
   */
  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const jql = typeof ctx.config.jql === 'string' ? ctx.config.jql.trim() : '';
    if (!jql) {
      await connectorFetch(`${jiraBase(ctx)}/rest/api/3/myself`, { headers: jiraHeaders(ctx), signal: ctx.signal }, ctx);
      return { ok: true };
    }
    const res = await connectorFetch(
      `${jiraBase(ctx)}/rest/api/3/search/approximate-count`,
      { method: 'POST', headers: { ...jiraHeaders(ctx), 'content-type': 'application/json' }, body: JSON.stringify({ jql }), signal: ctx.signal },
      ctx,
    );
    const { count } = (await res.json()) as { count?: number };
    return { ok: true, detail: `${count ?? 0} issues match this JQL` };
  }

  /**
   * `/rest/api/3/search/jql`, token-paged: the offset-paged `/search` it
   * replaces is deprecated and returns 410 on Jira Cloud.
   */
  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const base = jiraBase(ctx);
    let token: string | undefined;
    for (;;) {
      const page = await jiraSearch(ctx, requireConfig(ctx.config, 'jql'), { maxResults: PAGE_SIZE, fields: 'summary,updated', token });
      for (const issue of page.issues ?? []) {
        yield {
          externalId: issue.key,
          title: issue.fields?.summary ?? issue.key,
          url: `${base}/browse/${issue.key}`,
          version: issue.fields?.updated,
        };
      }
      token = page.nextPageToken;
      if (page.isLast || !token || !page.issues?.length) return;
    }
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const base = jiraBase(ctx);
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(ref.externalId)}?expand=renderedFields`;
    const issue = (await (
      await connectorFetch(url, { headers: jiraHeaders(ctx), signal: ctx.signal }, ctx)
    ).json()) as JiraIssue;

    const warnings: string[] = [];
    const rendered = issue.renderedFields?.description ?? '';
    const body = rendered ? htmlToMarkdown(rendered) : '';
    if (!body && issue.fields?.description) {
      // The issue has a description that Jira did not render for us.
      warnings.push('The description could not be rendered and was left out.');
    }

    const comments = issue.renderedFields?.comment?.comments ?? [];
    const commentBlock = comments
      .map((c) => `### ${c.author?.displayName ?? 'Comment'}\n\n${htmlToMarkdown(c.body ?? '')}`)
      .join('\n\n');

    const markdown = [body, commentBlock && `## Comments\n\n${commentBlock}`].filter(Boolean).join('\n\n');

    return {
      ref: { ...ref, version: issue.fields?.updated ?? ref.version },
      title: issue.fields?.summary ?? ref.externalId,
      markdown,
      // Issue metadata belongs in frontmatter, where the deterministic relation
      // extractor already reads tags and relations from (plan.md §5).
      frontmatter: dropEmpty({
        source: `${base}/browse/${issue.key}`,
        key: issue.key,
        status: issue.fields?.status?.name,
        type: issue.fields?.issuetype?.name,
        assignee: issue.fields?.assignee?.displayName,
        reporter: issue.fields?.reporter?.displayName,
        priority: issue.fields?.priority?.name,
        tags: issue.fields?.labels?.length ? issue.fields.labels : undefined,
      }),
      warnings,
    };
  }

  verifyWebhook(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): ExternalRef[] | null {
    const secret = ctx.webhookSecret;
    if (!secret || !verifyHubSignature(headers, rawBody, secret)) return null;
    const key = safeJson(rawBody)?.issue?.key;
    if (!key) return [];
    return [{ externalId: String(key), title: '' }];
  }

}

/** The site, as the admin typed it, without a trailing slash. Shared with the tracker (#424). */
export function jiraBase(ctx: Pick<ConnectorContext, 'config'>): string {
  return trimBaseUrl(requireConfig(ctx.config, 'baseUrl'));
}

/** `email:api-token`, as Basic auth. */
export function jiraHeaders(ctx: Pick<ConnectorContext, 'credential'>): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(ctx.credential ?? '').toString('base64')}`,
    accept: 'application/json',
  };
}

/** One page of `/rest/api/3/search/jql`. */
export async function jiraSearch(
  ctx: ConnectorContext,
  jql: string,
  opts: { maxResults: number; fields: string; token?: string },
): Promise<JiraSearch> {
  const url = new URL(`${jiraBase(ctx)}/rest/api/3/search/jql`);
  url.searchParams.set('jql', jql);
  url.searchParams.set('maxResults', String(opts.maxResults));
  url.searchParams.set('fields', opts.fields);
  if (opts.token) url.searchParams.set('nextPageToken', opts.token);
  return (await (
    await connectorFetch(url.toString(), { headers: jiraHeaders(ctx), signal: ctx.signal }, ctx)
  ).json()) as JiraSearch;
}

function dropEmpty(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

// --- upstream shapes (only the fields actually read) ---

export interface JiraSearch {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}
export interface JiraIssue {
  id?: string;
  key: string;
  fields?: {
    summary?: string;
    created?: string;
    updated?: string;
    description?: unknown;
    labels?: string[];
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    assignee?: { displayName?: string };
    reporter?: { displayName?: string };
    priority?: { name?: string };
  };
  renderedFields?: {
    description?: string;
    comment?: { comments?: Array<{ body?: string; author?: { displayName?: string } }> };
  };
}
