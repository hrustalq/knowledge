import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { htmlToMarkdown } from '../../import/parsers/html-to-markdown.js';
import { safeJson, verifyHubSignature } from './confluence.adapter.js';
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
  readonly capabilities: ConnectorCapabilities = { pull: true, push: false, webhook: true };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const page = await this.search(ctx, 0, 1);
    return { ok: true, detail: `${page.total ?? 0} issues match this JQL` };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const base = this.base(ctx);
    let startAt = 0;
    for (;;) {
      const page = await this.search(ctx, startAt, PAGE_SIZE);
      const issues = page.issues ?? [];
      for (const issue of issues) {
        yield {
          externalId: issue.key,
          title: issue.fields?.summary ?? issue.key,
          url: `${base}/browse/${issue.key}`,
          version: issue.fields?.updated,
        };
      }
      startAt += issues.length;
      if (issues.length === 0 || startAt >= (page.total ?? 0)) return;
    }
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const base = this.base(ctx);
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(ref.externalId)}?expand=renderedFields`;
    const issue = (await (
      await connectorFetch(url, { headers: this.headers(ctx), signal: ctx.signal })
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

  private base(ctx: ConnectorContext): string {
    return trimBaseUrl(requireConfig(ctx.config, 'baseUrl'));
  }

  private headers(ctx: ConnectorContext): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(ctx.credential ?? '').toString('base64')}`,
      accept: 'application/json',
    };
  }

  private async search(ctx: ConnectorContext, startAt: number, maxResults: number): Promise<JiraSearch> {
    const base = this.base(ctx);
    const url = new URL(`${base}/rest/api/3/search`);
    url.searchParams.set('jql', requireConfig(ctx.config, 'jql'));
    url.searchParams.set('startAt', String(startAt));
    url.searchParams.set('maxResults', String(maxResults));
    url.searchParams.set('fields', 'summary,updated');
    return (await (
      await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal })
    ).json()) as JiraSearch;
  }
}

function dropEmpty(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

// --- upstream shapes (only the fields actually read) ---

interface JiraSearch {
  total?: number;
  issues?: JiraIssue[];
}
interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    updated?: string;
    description?: unknown;
    labels?: string[];
    status?: { name?: string };
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
