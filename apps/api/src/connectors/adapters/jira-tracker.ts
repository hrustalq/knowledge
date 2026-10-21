import { BadRequestException, Injectable } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import { t } from '../../i18n/t.js';
import { ConnectorsService } from '../connectors.service.js';
import { safeJson, verifyHubSignature } from '../webhook-payload.js';
import { ConnectorRequestError, connectorFetch, type ConnectorContext } from './connector.types.js';
import { jiraBase, jiraHeaders, jiraSearch, type JiraIssue } from './jira.adapter.js';
import { labelFor, type TrackerAdapter, type TrackerBodyLine, type TrackerCreateInput, type TrackerIssue, type TrackerRef } from './tracker.js';

const FIELDS = 'summary,status,labels,assignee,reporter,created,updated,description,issuetype';
const PAGE = 100;
/** JQL dates are in the API user's own timezone, which we cannot see; re-reading a day is cheap and idempotent. */
const JQL_SKEW_MS = 24 * 60 * 60 * 1000;
/** `key in (…)` grows with the anchored tickets; past this the label alone carries the poll. */
const MAX_WATCHED = 200;
const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Jira Cloud as a tracker (#424), on the existing `jira` kind: the same site
 * URL and `email:api-token` credential as the content pull, which stays
 * optional and separate — a ticket is never a page.
 *
 * `number` is Jira's site-wide issue id, which is what keeps one connector
 * serving several Jira projects unique on (connector, kind, number); the key a
 * person cites (`BILL-123`) is `externalKey`. Bodies are Atlassian Document
 * Format, built from three kinds of line, so no markdown→ADF converter exists.
 */
@Injectable()
export class JiraTrackerService implements TrackerAdapter {
  readonly kind = 'jira' as const;

  constructor(private readonly connectors: ConnectorsService) {}

  supports(row: Connector): boolean {
    return row.kind === 'jira';
  }

  async listIssues(row: Connector, since: string | null, watch: TrackerRef[] = []) {
    const ctx = await this.ctx(row);
    const keys = watch.map((r) => r.externalKey).filter((k): k is string => !!k && KEY.test(k)).slice(0, MAX_WATCHED);
    const who = `labels = ${jqlString(labelFor(row))}${keys.length ? ` OR key in (${keys.join(', ')})` : ''}`;
    const when = since ? ` AND updated >= ${jqlString(jqlDate(new Date(Date.parse(since) - JQL_SKEW_MS)))}` : '';
    const page = await jiraSearch(ctx, `(${who})${when} ORDER BY updated ASC`, { maxResults: PAGE, fields: FIELDS });
    const items = (page.issues ?? []).map((issue) => toTrackerIssue(ctx, issue));
    const cursor = items.reduce<string | null>(
      (max, item) => (item.externalUpdatedAt && (!max || item.externalUpdatedAt > max) ? item.externalUpdatedAt : max),
      since,
    );
    return { items, cursor };
  }

  async getIssue(row: Connector, ref: TrackerRef): Promise<TrackerIssue | null> {
    const ctx = await this.ctx(row);
    const id = ref.externalKey ?? String(ref.number);
    const res = await this.call(ctx, `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${FIELDS}`);
    return res ? toTrackerIssue(ctx, (await res.json()) as JiraIssue) : null;
  }

  /** `BILL-123`, or `<site>/browse/BILL-123` on this connector's site. */
  parseRef(row: Connector, text: string): TrackerRef | null {
    const raw = text.trim();
    let key = raw.toUpperCase();
    if (raw.startsWith('http')) {
      let base: string;
      try {
        base = jiraBase({ config: row.config as Record<string, unknown> });
      } catch {
        return null;
      }
      const m = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)\/?$/.exec(raw);
      if (!m || !raw.toLowerCase().startsWith(base.toLowerCase() + '/')) return null;
      key = m[1].toUpperCase();
    }
    return KEY.test(key) ? { number: 0, externalKey: key } : null;
  }

  async createIssue(row: Connector, input: TrackerCreateInput): Promise<TrackerIssue> {
    const ctx = await this.ctx(row);
    const project = input.externalProject?.trim() || (typeof ctx.config.projectKey === 'string' ? ctx.config.projectKey.trim() : '');
    if (!project) throw new BadRequestException(t('error.workItem.jiraNoProject', { name: row.name }));
    const res = await this.call(ctx, '/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: project },
          summary: input.title,
          issuetype: { name: input.issueType?.trim() || 'Task' },
          labels: input.labels,
          description: adf(input.lines),
        },
      }),
    });
    const created = (await res!.json()) as { key: string };
    const issue = await this.getIssue(row, { number: 0, externalKey: created.key });
    if (!issue) throw new BadRequestException(t('error.workItem.ticketNotFound', { ref: created.key, name: row.name }));
    return issue;
  }

  /**
   * Jira moves a ticket through a named transition, not to a status, so this
   * picks the transition available now whose target status (or own name)
   * matches. None matching is the map asking for something this workflow
   * cannot do from here — reported, never guessed.
   */
  async transition(row: Connector, ref: TrackerRef, externalStatus: string): Promise<TrackerIssue | null> {
    const ctx = await this.ctx(row);
    const id = encodeURIComponent(ref.externalKey ?? String(ref.number));
    const res = await this.call(ctx, `/rest/api/3/issue/${id}/transitions`);
    if (!res) return null;
    const { transitions = [] } = (await res.json()) as { transitions?: Array<{ id: string; name?: string; to?: { name?: string } }> };
    const want = externalStatus.toLowerCase();
    const current = await this.getIssue(row, ref);
    if (current?.externalStatus?.toLowerCase() === want) return current;
    const pick = transitions.find((tr) => tr.to?.name?.toLowerCase() === want) ?? transitions.find((tr) => tr.name?.toLowerCase() === want);
    if (!pick) throw new BadRequestException(t('error.workItem.unknownStatus', { status: externalStatus }));
    await this.call(ctx, `/rest/api/3/issue/${id}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: pick.id } }) });
    return this.getIssue(row, ref);
  }

  async comment(row: Connector, ref: TrackerRef, lines: TrackerBodyLine[]): Promise<void> {
    const ctx = await this.ctx(row);
    const id = encodeURIComponent(ref.externalKey ?? String(ref.number));
    await this.call(ctx, `/rest/api/3/issue/${id}/comment`, { method: 'POST', body: JSON.stringify({ body: adf(lines) }) });
  }

  /** A Jira webhook with a secret signs `X-Hub-Signature` like GitHub does. */
  verifyWebhook(row: Connector, secret: string, headers: Record<string, string>, rawBody: string) {
    if (!verifyHubSignature(headers, rawBody, secret)) return null;
    const payload = safeJson(rawBody);
    const issue = payload?.issue as JiraIssue | undefined;
    const actor: unknown = payload?.user?.accountId;
    if (!issue?.key) return { item: null, actorId: null };
    return {
      item: toTrackerIssue({ config: row.config as Record<string, unknown> }, issue),
      actorId: typeof actor === 'string' ? actor : null,
    };
  }

  // --- internals ---

  private ctx(row: Connector): Promise<ConnectorContext> {
    return this.connectors.contextFor(row, async () => undefined);
  }

  /** A request whose 404 means "gone or not visible": null. Anything else non-2xx throws. */
  private async call(ctx: ConnectorContext, path: string, init: { method?: string; body?: string } = {}): Promise<Response | null> {
    try {
      return await connectorFetch(
        `${jiraBase(ctx)}${path}`,
        { ...init, headers: { ...jiraHeaders(ctx), ...(init.body ? { 'content-type': 'application/json' } : {}) } },
        ctx,
      );
    } catch (err) {
      if (err instanceof ConnectorRequestError && err.status === 404) return null;
      throw err;
    }
  }
}

/** A JQL string literal. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `yyyy/MM/dd HH:mm`, the one date format JQL accepts with minutes. */
function jqlDate(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}/${p(at.getUTCMonth() + 1)}/${p(at.getUTCDate())} ${p(at.getUTCHours())}:${p(at.getUTCMinutes())}`;
}

export function toTrackerIssue(ctx: Pick<ConnectorContext, 'config'>, issue: JiraIssue): TrackerIssue {
  const f = issue.fields ?? {};
  const iso = (v?: string) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    kind: 'issue',
    number: Number(issue.id ?? 0),
    externalKey: issue.key,
    title: f.summary ?? issue.key,
    // The category, not the name, decides open/closed: a team's "Shipped" is
    // still in the `done` category.
    state: f.status?.statusCategory?.key === 'done' ? 'closed' : 'open',
    externalStatus: f.status?.name ?? null,
    url: `${jiraBase(ctx)}/browse/${issue.key}`,
    authorLogin: f.reporter?.displayName ?? null,
    assigneeLogins: f.assignee?.displayName ? [f.assignee.displayName] : [],
    labels: f.labels ?? [],
    body: adfText(f.description),
    externalCreatedAt: iso(f.created),
    externalUpdatedAt: iso(f.updated),
  };
}

/** Lines as an ADF document: one paragraph each, a link mark where it links. */
export function adf(lines: TrackerBodyLine[]): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: lines
      .filter((l) => l.text)
      .map((l) => ({
        type: 'paragraph',
        content: [
          'link' in l ? { type: 'text', text: l.text, marks: [{ type: 'link', attrs: { href: l.link } }] } : { type: 'text', text: l.text },
        ],
      })),
  };
}

/** The plain text of an ADF tree, one line per block — enough to find a `knowledge-ref:` footer. */
export function adfText(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const out: string[] = [];
  const walk = (n: { type?: string; text?: string; content?: unknown[] }, line: string[]): void => {
    if (typeof n.text === 'string') line.push(n.text);
    for (const child of n.content ?? []) {
      if (!child || typeof child !== 'object') continue;
      const c = child as { type?: string };
      if (c.type === 'paragraph' || c.type === 'heading') {
        const own: string[] = [];
        walk(child as never, own);
        out.push(own.join(''));
      } else walk(child as never, line);
    }
  };
  const top: string[] = [];
  walk(node as never, top);
  if (top.length) out.unshift(top.join(''));
  return out.join('\n') || null;
}
