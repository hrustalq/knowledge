import { timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import { connectorKindInfo } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { ConnectorsService } from '../connectors.service.js';
import { safeJson } from '../webhook-payload.js';
import { ConnectorRequestError, connectorFetch, type ConnectorContext } from './connector.types.js';
import { gitlabHeaders, repoHost, type RepoHost } from './repo-archive.js';
import { markdownBody, type TrackerAdapter, type TrackerBodyLine, type TrackerCreateInput, type TrackerIssue, type TrackerRef } from './tracker.js';

const PAGE = 100;

/**
 * GitLab Issues as a tracker (#424), on a `markdown-git` or `codebase`
 * connector whose repository is on GitLab — gitlab.com or a self-hosted
 * instance, reached through `connectorFetch` and so through the one SSRF
 * filter. The credential is the connector's own project or group access token.
 *
 * GitLab's statuses are `opened` and `closed`, nothing else, so the default
 * status map sends both `done` and `wont_do` to `closed`.
 */
@Injectable()
export class GitlabTrackerService implements TrackerAdapter {
  readonly kind = 'gitlab' as const;

  constructor(private readonly connectors: ConnectorsService) {}

  supports(row: Connector): boolean {
    return !!connectorKindInfo(row.kind)?.capabilities.tasks && hostOf(row)?.kind === 'gitlab';
  }

  async listIssues(row: Connector, since: string | null) {
    const { ctx, project } = await this.target(row);
    const query = `scope=all&order_by=updated_at&sort=asc&per_page=${PAGE}${since ? `&updated_after=${encodeURIComponent(since)}` : ''}`;
    const res = await this.call(ctx, `${project}/issues?${query}`);
    const raw = res ? ((await res.json()) as RawGitlabIssue[]) : [];
    const items = (Array.isArray(raw) ? raw : []).map(toTrackerIssue);
    const cursor = items.reduce<string | null>(
      (max, item) => (item.externalUpdatedAt && (!max || item.externalUpdatedAt > max) ? item.externalUpdatedAt : max),
      since,
    );
    return { items, cursor };
  }

  async getIssue(row: Connector, ref: TrackerRef): Promise<TrackerIssue | null> {
    const { ctx, project } = await this.target(row);
    const res = await this.call(ctx, `${project}/issues/${ref.number}`);
    return res ? toTrackerIssue((await res.json()) as RawGitlabIssue) : null;
  }

  /** `#45`, `45`, `group/sub/repo#45` or `<origin>/<path>/-/issues/45`, on this project only. */
  parseRef(row: Connector, text: string): TrackerRef | null {
    const host = hostOf(row);
    if (!host) return null;
    const raw = text.trim();
    const own = (path: string) => path.toLowerCase() === host.path.toLowerCase();
    let m = /^#?(\d+)$/.exec(raw);
    if (m) return { number: Number(m[1]), externalKey: null };
    m = /^([\w./-]+)#(\d+)$/.exec(raw);
    if (m) return own(m[1]) ? { number: Number(m[2]), externalKey: null } : null;
    if (raw.toLowerCase().startsWith(host.origin.toLowerCase() + '/')) {
      m = /^\/(.+)\/-\/issues\/(\d+)\/?$/.exec(raw.slice(host.origin.length));
      if (m && own(m[1])) return { number: Number(m[2]), externalKey: null };
    }
    return null;
  }

  async createIssue(row: Connector, input: TrackerCreateInput): Promise<TrackerIssue> {
    const { ctx, project } = await this.target(row);
    const res = await this.call(ctx, `${project}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: input.title, description: markdownBody(input.lines), labels: input.labels.join(',') }),
    });
    return toTrackerIssue((await res!.json()) as RawGitlabIssue);
  }

  /** `opened` reopens, `closed` closes: the only two states GitLab has. */
  async transition(row: Connector, ref: TrackerRef, externalStatus: string): Promise<TrackerIssue | null> {
    const event = externalStatus === 'closed' ? 'close' : externalStatus === 'opened' ? 'reopen' : null;
    if (!event) throw new BadRequestException(t('error.workItem.unknownStatus', { status: externalStatus }));
    const { ctx, project } = await this.target(row);
    const res = await this.call(ctx, `${project}/issues/${ref.number}`, { method: 'PUT', body: JSON.stringify({ state_event: event }) });
    return res ? toTrackerIssue((await res.json()) as RawGitlabIssue) : null;
  }

  async comment(row: Connector, ref: TrackerRef, lines: TrackerBodyLine[]): Promise<void> {
    const { ctx, project } = await this.target(row);
    await this.call(ctx, `${project}/issues/${ref.number}/notes`, { method: 'POST', body: JSON.stringify({ body: markdownBody(lines) }) });
  }

  /**
   * GitLab signs nothing: it sends the hook's secret token back verbatim in
   * `X-Gitlab-Token`. Only an `Issue Hook` is about a ticket; any other event
   * verifies here as "not a ticket" and goes on to the repository paths.
   */
  verifyWebhook(_row: Connector, secret: string, headers: Record<string, string>, rawBody: string) {
    if (headers['x-gitlab-event'] !== 'Issue Hook') return { item: null, actorId: null };
    const given = Buffer.from(headers['x-gitlab-token'] ?? '');
    const want = Buffer.from(secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const payload = safeJson(rawBody);
    const attrs = payload?.object_attributes as RawGitlabIssue | undefined;
    if (!attrs?.iid) return { item: null, actorId: null };
    const labels = Array.isArray(payload?.labels) ? (payload.labels as Array<{ title?: string }>).map((l) => l.title ?? '') : [];
    const actor: unknown = payload?.user?.id;
    return {
      item: toTrackerIssue({ ...attrs, web_url: attrs.web_url ?? attrs.url, labels }),
      actorId: typeof actor === 'number' || typeof actor === 'string' ? String(actor) : null,
    };
  }

  // --- internals ---

  private async target(row: Connector): Promise<{ ctx: ConnectorContext; project: string }> {
    const ctx = await this.connectors.contextFor(row, async () => undefined);
    const host = repoHost(ctx);
    return { ctx, project: `${host.origin}/api/v4/projects/${encodeURIComponent(host.path)}` };
  }

  /** A 404 is "gone, or the token cannot see it": null. Anything else non-2xx throws. */
  private async call(ctx: ConnectorContext, url: string, init: { method?: string; body?: string } = {}): Promise<Response | null> {
    try {
      return await connectorFetch(
        url,
        { ...init, headers: { ...gitlabHeaders(ctx), ...(init.body ? { 'content-type': 'application/json' } : {}) }, signal: ctx.signal },
        ctx,
      );
    } catch (err) {
      if (err instanceof ConnectorRequestError && err.status === 404) return null;
      throw err;
    }
  }
}

function hostOf(row: Connector): RepoHost | null {
  try {
    return repoHost({ config: row.config, locale: row.locale } as never);
  } catch {
    return null;
  }
}

interface RawGitlabIssue {
  id?: number;
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  web_url?: string;
  url?: string;
  author?: { username?: string } | null;
  assignees?: Array<{ username?: string }> | null;
  labels?: Array<string | { title?: string }> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export function toTrackerIssue(raw: RawGitlabIssue): TrackerIssue {
  const iso = (v?: string | null) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
  const closed = raw.state === 'closed';
  return {
    kind: 'issue',
    number: raw.iid,
    externalKey: null,
    title: raw.title,
    state: closed ? 'closed' : 'open',
    externalStatus: closed ? 'closed' : 'opened',
    url: raw.web_url ?? raw.url ?? '',
    authorLogin: raw.author?.username ?? null,
    assigneeLogins: (raw.assignees ?? []).map((a) => a?.username).filter((u): u is string => Boolean(u)),
    labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.title ?? ''))).filter(Boolean),
    body: raw.description ?? null,
    externalCreatedAt: iso(raw.created_at),
    externalUpdatedAt: iso(raw.updated_at),
  };
}
