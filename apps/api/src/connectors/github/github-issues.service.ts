import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import type {
  ConnectorWorkItemKind,
  ConnectorWorkItemState,
  CreateConnectorWorkItemInput,
} from '@knowledge/contracts';
import { safeFetch } from '../../common/safe-fetch.js';
import { t } from '../../i18n/t.js';
import { repoHost } from '../adapters/repo-archive.js';
import { ConnectorsService } from '../connectors.service.js';
import { GithubAppService } from './github-app.service.js';

/**
 * Issues and pull requests on a connected GitHub repository (docs/features/32).
 *
 * The house rule that adapters talk plain `fetch` with no per-vendor SDK holds
 * here for the reason feature 30 gave: the whole surface this file needs is five
 * REST endpoints and one GraphQL query, which is less code than teaching Octokit
 * about our credential resolution.
 *
 * Deliberately *not* a `ConnectorAdapter`. An adapter moves content — `list`,
 * `fetch`, `push`, and a `verifyWebhook` answering in `ExternalRef`s — and every
 * one of those verbs means something else here. Bolting work items onto that
 * interface would have added six optional methods five of the six adapters
 * answer `undefined` to.
 */

/** One page of issues is plenty for a detail page; the far side is the index, not us. */
const MAX_ITEMS = 100;

/** A board query that walks a whole backlog is a GraphQL bill. The tab shows a page. */
const MAX_BOARD_LOOKUPS = 50;

export interface GithubWorkItem {
  kind: ConnectorWorkItemKind;
  number: number;
  title: string;
  state: ConnectorWorkItemState;
  url: string;
  authorLogin: string | null;
  assigneeLogins: string[];
  labels: string[];
  externalCreatedAt: string | null;
  externalUpdatedAt: string | null;
}

/** Where a request is going and what it may use to get there. */
interface RepoTarget {
  owner: string;
  repo: string;
  /** `owner/repo`, both segments already URL-encoded. */
  path: string;
  credential: string;
}

@Injectable()
export class GithubIssuesService {
  private readonly logger = new Logger(GithubIssuesService.name);

  constructor(
    private readonly connectors: ConnectorsService,
    private readonly app: GithubAppService,
  ) {}

  /**
   * Open and closed issues and pull requests, most recently touched first.
   *
   * GitHub's `/issues` endpoint returns pull requests too — a pull request is an
   * issue with a `pull_request` key — which is why one call covers both kinds,
   * and why the discriminator in `toWorkItem` reads that key rather than costing
   * a second request.
   */
  async list(row: Connector, state: 'open' | 'closed' | 'all' = 'all'): Promise<GithubWorkItem[]> {
    const target = await this.target(row);
    const query = `state=${state}&per_page=${MAX_ITEMS}&sort=updated&direction=desc`;
    const res = await this.request(target, `/repos/${target.path}/issues?${query}`);
    const raw: unknown = await res.json();
    return Array.isArray(raw) ? (raw as RawIssue[]).map(toWorkItem) : [];
  }

  /** One item by number, for refreshing a single row after an event. */
  async get(row: Connector, number: number): Promise<GithubWorkItem | null> {
    const target = await this.target(row);
    const res = await this.request(target, `/repos/${target.path}/issues/${number}`, {}, true);
    if (!res.ok) return null;
    return toWorkItem((await res.json()) as RawIssue);
  }

  /** Hand a task to the repository — the outbound half of the handoff. */
  async create(row: Connector, input: CreateConnectorWorkItemInput): Promise<GithubWorkItem> {
    const target = await this.target(row);
    const res = await this.request(target, `/repos/${target.path}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.assignees?.length ? { assignees: input.assignees } : {}),
      }),
    });
    return toWorkItem((await res.json()) as RawIssue);
  }

  /** Add a remark to an existing item — how a flow reports back what it did. */
  async comment(row: Connector, number: number, body: string): Promise<void> {
    const target = await this.target(row);
    await this.request(target, `/repos/${target.path}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  /** Close an item, as completed or as abandoned. */
  async close(row: Connector, number: number, reason: 'completed' | 'not_planned' = 'completed'): Promise<void> {
    const target = await this.target(row);
    await this.request(target, `/repos/${target.path}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: reason }),
    });
  }

  /**
   * Which Projects v2 boards carry each of these numbers.
   *
   * Projects v2 has no REST surface at all, so this is the one GraphQL call in
   * the product. It is batched with field aliases — one request for a page of
   * rows rather than one per row — and capped, because the alternative is a
   * query whose cost grows with somebody's backlog.
   *
   * The selection is spelled out on both concrete types rather than through a
   * fragment on the interface they share: `issueOrPullRequest` is a union, and
   * naming the interface would make this query's validity depend on a GitHub
   * schema detail that buys nothing here.
   *
   * Failure is an empty map, never a throw. Board membership is decoration on a
   * list whose substance came from REST, and a GraphQL hiccup must not take the
   * Work items tab down with it.
   */
  async boardsFor(row: Connector, numbers: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    const wanted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_BOARD_LOOKUPS);
    if (wanted.length === 0) return out;

    try {
      const target = await this.target(row);
      const selection = 'projectItems(first: 10) { nodes { project { title } } }';
      const aliases = wanted
        .map(
          (n) =>
            `i${n}: issueOrPullRequest(number: ${n}) { ... on Issue { ${selection} } ... on PullRequest { ${selection} } }`,
        )
        .join('\n');
      const query = `query { repository(owner: ${JSON.stringify(target.owner)}, name: ${JSON.stringify(
        target.repo,
      )}) { ${aliases} } }`;

      const res = await this.request(target, '/graphql', { method: 'POST', body: JSON.stringify({ query }) });
      const body = (await res.json()) as { data?: { repository?: Record<string, RawProjectNode | null> } };
      for (const [alias, node] of Object.entries(body.data?.repository ?? {})) {
        const number = Number(alias.slice(1));
        const titles = (node?.projectItems?.nodes ?? [])
          .map((item) => item?.project?.title)
          .filter((title): title is string => typeof title === 'string' && title !== '');
        if (Number.isFinite(number) && titles.length > 0) out.set(number, titles);
      }
    } catch (err) {
      this.logger.warn(`projects v2 lookup failed for connector ${row.id}: ${(err as Error).message}`);
    }
    return out;
  }

  // --- internals ---

  /**
   * Resolve owner, repo and credential once per public call.
   *
   * `repoHost` is the same parser the two repository adapters use, so a GitLab
   * remote is refused here by reading the config it would have read, rather than
   * by a 404 from a GitHub path built out of a GitLab URL.
   */
  private async target(row: Connector): Promise<RepoTarget> {
    const ctx = await this.connectors.contextFor(row, async () => undefined);
    const host = repoHost(ctx);
    if (host.kind !== 'github') throw new BadRequestException(t('error.connector.workItemsGithubOnly'));
    if (!ctx.credential) throw new BadRequestException(t('error.connector.workItemsNoCredential'));
    return {
      owner: host.owner,
      repo: host.repo,
      path: `${encodeURIComponent(host.owner)}/${encodeURIComponent(host.repo)}`,
      credential: ctx.credential,
    };
  }

  private async request(
    target: RepoTarget,
    path: string,
    init: RequestInit = {},
    tolerateNotFound = false,
  ): Promise<Response> {
    const res = await safeFetch(
      `${this.app.apiUrl}${path}`,
      {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'knowledge-connector',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${target.credential}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      },
      // GitHub is a public host, so private addresses stay refused even when
      // CONNECTOR_ALLOW_PRIVATE_URLS is on for a self-hosted Confluence.
      false,
    );
    if (!res.ok && !(tolerateNotFound && res.status === 404)) {
      // GitHub answers 404 rather than 403 for "you cannot see this", deliberately
      // and unrecoverably, so the message says both readings instead of picking
      // one — the same lesson #28 taught the archive download.
      const detail = res.status === 404 ? t('error.connector.workItemsNotVisible') : String(res.status);
      throw new BadRequestException(t('error.connector.workItemsRequestFailed', { detail }));
    }
    return res;
  }
}

interface RawProjectNode {
  projectItems?: { nodes?: Array<{ project?: { title?: string } } | null> };
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user?: { login?: string } | null;
  assignees?: Array<{ login?: string }> | null;
  labels?: Array<{ name?: string } | string> | null;
  pull_request?: { merged_at?: string | null } | null;
  draft?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * GitHub's shape onto ours.
 *
 * The state mapping is the part worth reading. A merged pull request reports
 * `state: 'closed'` exactly like an abandoned one, and the two say opposite
 * things about whether the work happened; `merged_at` is the only field that
 * separates them. That is why a flow keying off "done" reads our `merged` and
 * not GitHub's `closed`.
 */
export function toWorkItem(raw: RawIssue): GithubWorkItem {
  const isPr = Boolean(raw.pull_request);
  let state: ConnectorWorkItemState;
  if (isPr && raw.pull_request?.merged_at) state = 'merged';
  else if (raw.state === 'closed') state = 'closed';
  else if (isPr && raw.draft) state = 'draft';
  else state = 'open';

  return {
    kind: isPr ? 'pull-request' : 'issue',
    number: raw.number,
    title: raw.title,
    state,
    url: raw.html_url,
    authorLogin: raw.user?.login ?? null,
    assigneeLogins: (raw.assignees ?? []).map((a) => a?.login).filter((l): l is string => Boolean(l)),
    labels: (raw.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter((l): l is string => Boolean(l)),
    externalCreatedAt: raw.created_at ?? null,
    externalUpdatedAt: raw.updated_at ?? null,
  };
}
