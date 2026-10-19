import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  ANALYTICS_DEFAULT_DAYS,
  ANALYTICS_MAX_DAYS,
  TRAFFIC_CLASSES,
  channelsForTrafficClass,
  type AnalyticsAgentsResponse,
  type AnalyticsDayPoint,
  type AnalyticsKeyRow,
  type AnalyticsOperationRow,
  type AnalyticsOverviewResponse,
  type AnalyticsPageLists,
  type AnalyticsPageRow,
  type AnalyticsPagesResponse,
  type AnalyticsQueryRow,
  type AnalyticsQuietPage,
  type AnalyticsReport,
  type AnalyticsSearchResponse,
  type AnalyticsToolRow,
  type AnalyticsTrafficFilter,
  type AnalyticsViewTotals,
  type AnalyticsWindow,
  type PageInsightsResponse,
  type ProjectAnalyticsResponse,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { listedSql } from '../common/listed-page.js';
import { visibilitySql, type AccessScope } from '../permissions/access-scope.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalyticsRecorder } from './analytics.recorder.js';
import { HUMAN_CHANNELS, quietPageSql, readSignalsColumnsSql, readSignalsJoinSql } from './read-signals.js';

const DAY_MS = 86_400_000;
/** Rows in each list of the project dashboard: a glance, not a report. */
const LIST_LIMIT = 10;
/** Rows in each list of the workspace dashboard. */
const DASHBOARD_LIMIT = 100;
/** Rows one CSV export carries. */
// ponytail: an export is built in memory up to this cap; stream rows from a cursor if a workspace outgrows it
export const EXPORT_LIMIT = 5000;
/** A reader repeating one query within this many seconds (a filter toggle re-runs it) is one search. */
const REPEAT_SECONDS = 10;

/** Which page views a rollup counts. */
interface ViewFilter {
  workspaceId: string;
  from: Date;
  traffic: AnalyticsTrafficFilter;
  documentId?: string;
  projectId?: string;
  /** Counts only pages this caller may open. Absent when the route already checked the one page. */
  scope?: AccessScope;
}

interface TotalsRow {
  views: number;
  human: number;
  assisted: number;
  agent: number;
  readers: number;
  median: number | null;
}

/**
 * The read side of usage analytics (#79): every number is a rollup over the
 * event rows at read time — no stored aggregate, so no second answer.
 *
 * Views are counted through `documents`, under the caller's `AccessScope`: a
 * page they may not open contributes neither a title nor a count, and a
 * deleted page's views drop out with it. A page moved to another project takes
 * its views along — the project filter reads the page's project now, not the
 * one denormalized on the row when it was read.
 */
@Injectable()
export class AnalyticsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly recorder: AnalyticsRecorder,
  ) {}

  /** One page over the last 30 days. The route has checked the caller may open it. */
  async pageInsights(documentId: string): Promise<PageInsightsResponse> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId }, select: { workspaceId: true } });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    const to = new Date();
    const from = new Date(to.getTime() - ANALYTICS_DEFAULT_DAYS * DAY_MS);
    const [totals, last, collectingSince] = await Promise.all([
      this.totals({ workspaceId: doc.workspaceId, from, traffic: 'all', documentId }),
      this.prisma.$queryRaw<Array<{ at: Date | null }>>`
        SELECT max(created_at) AS at FROM page_views
         WHERE document_id = ${documentId}::uuid AND channel IN (${Prisma.join(HUMAN_CHANNELS)})`,
      this.collectingSince(doc.workspaceId),
    ]);
    return {
      documentId,
      from: from.toISOString(),
      to: to.toISOString(),
      ...totals,
      lastHumanViewAt: last[0]?.at?.toISOString() ?? null,
      collectingSince,
    };
  }

  /** A project's reading over `days`: totals, the most read pages, and the pages nobody reads. */
  async project(
    scope: AccessScope,
    projectId: string,
    days = ANALYTICS_DEFAULT_DAYS,
    traffic: AnalyticsTrafficFilter = 'all',
  ): Promise<ProjectAnalyticsResponse> {
    const w = await this.window(scope.workspaceId, days, traffic);
    const filter: ViewFilter = { workspaceId: scope.workspaceId, from: new Date(w.from), traffic, projectId, scope };
    const [totals, lists] = await Promise.all([this.totals(filter), this.pageLists(scope, filter, w, LIST_LIMIT)]);
    return { projectId, ...w, ...totals, ...lists };
  }

  /** The workspace dashboard's headline numbers. */
  async overview(scope: AccessScope, days = ANALYTICS_DEFAULT_DAYS, traffic: AnalyticsTrafficFilter = 'all'): Promise<AnalyticsOverviewResponse> {
    const { workspaceId } = scope;
    const w = await this.window(workspaceId, days, traffic);
    const from = new Date(w.from);
    const counts = (cls: 'assisted' | 'agent') => traffic === 'all' || traffic === cls;
    const [totals, searches, questions, mcp, recording] = await Promise.all([
      this.totals({ workspaceId, from, traffic, scope }),
      this.prisma.$queryRaw<Array<{ searches: number; zero: number; web: number; clicks: number }>>`
        WITH ${searchCtesSql(workspaceId, from, traffic)}
        SELECT count(*) FILTER (WHERE s.kept)::int AS searches,
               count(*) FILTER (WHERE s.kept AND s.result_count = 0)::int AS zero,
               count(*) FILTER (WHERE s.kept AND s.channel = 'web' AND s.result_count > 0)::int AS web,
               count(c.search_id) FILTER (WHERE s.channel = 'web')::int AS clicks
          FROM s LEFT JOIN c ON c.search_id = s.id`,
      counts('assisted') ? this.questionSeries(workspaceId, from) : null,
      counts('agent')
        ? this.prisma.mcpToolCall.count({ where: { workspaceId, createdAt: { gte: from } } })
        : null,
      this.recorder.enabled(workspaceId),
    ]);
    const s = searches[0];
    return {
      workspaceId,
      ...w,
      ...totals,
      recording,
      searches: s?.searches ?? 0,
      zeroResultSearches: s?.zero ?? 0,
      clickThrough: rate(s?.clicks ?? 0, s?.web ?? 0),
      assistantQuestions: questions ? questions.reduce((n, d) => n + d.count, 0) : null,
      mcpCalls: mcp,
    };
  }

  /** The workspace's most read, never read and dead pages. */
  async pages(scope: AccessScope, days = ANALYTICS_DEFAULT_DAYS, traffic: AnalyticsTrafficFilter = 'all'): Promise<AnalyticsPagesResponse> {
    const w = await this.window(scope.workspaceId, days, traffic);
    const filter: ViewFilter = { workspaceId: scope.workspaceId, from: new Date(w.from), traffic, scope };
    return { workspaceId: scope.workspaceId, ...w, ...(await this.pageLists(scope, filter, w, DASHBOARD_LIMIT)) };
  }

  /** What people and agents searched for, what found nothing, and what found results nobody opened. */
  async search(workspaceId: string, days = ANALYTICS_DEFAULT_DAYS, traffic: AnalyticsTrafficFilter = 'all'): Promise<AnalyticsSearchResponse> {
    const w = await this.window(workspaceId, days, traffic);
    const from = new Date(w.from);
    const [top, zeroResult, noClick] = await Promise.all(
      (['top', 'zero', 'no-click'] as const).map((kind) => this.queryGroups(workspaceId, from, traffic, kind, DASHBOARD_LIMIT)),
    );
    return { workspaceId, ...w, top, zeroResult, noClick };
  }

  /** MCP calls by tool and by key, and the assistant's volume. Not filtered by traffic: each list is one class already. */
  async agents(workspaceId: string, days = ANALYTICS_DEFAULT_DAYS): Promise<AnalyticsAgentsResponse> {
    const to = new Date();
    const from = new Date(to.getTime() - clampDays(days) * DAY_MS);
    const [tools, keys, questionSeries, operations] = await Promise.all([
      this.tools(workspaceId, from, DASHBOARD_LIMIT),
      this.keys(workspaceId, from, DASHBOARD_LIMIT),
      this.questionSeries(workspaceId, from),
      this.operations(workspaceId, from),
    ]);
    return {
      workspaceId,
      from: from.toISOString(),
      to: to.toISOString(),
      tools,
      keys,
      assistantQuestions: questionSeries.reduce((n, d) => n + d.count, 0),
      questionSeries,
      operations,
    };
  }

  /**
   * One dashboard table as CSV rows, up to EXPORT_LIMIT. Columns are stable
   * English identifiers — a machine interface. No reader column, ever.
   */
  async report(
    scope: AccessScope,
    report: AnalyticsReport,
    days = ANALYTICS_DEFAULT_DAYS,
    traffic: AnalyticsTrafficFilter = 'all',
  ): Promise<{ columns: string[]; rows: unknown[][] }> {
    const { workspaceId } = scope;
    const to = new Date();
    const from = new Date(to.getTime() - clampDays(days) * DAY_MS);
    const filter: ViewFilter = { workspaceId, from, traffic, scope };
    const deadSince = new Date(to.getTime() - this.config.get('ANALYTICS_DEAD_PAGE_DAYS', { infer: true }) * DAY_MS);
    const quiet = (p: AnalyticsQuietPage) => [p.documentId, p.title, p.createdAt, p.lastHumanViewAt];
    const queries = (q: AnalyticsQueryRow) => [q.queryHash, q.queryText, q.searches, q.zeroResults, q.clickThrough, q.meanClickedRank, q.lastSearchedAt];
    const QUIET = ['document_id', 'title', 'created_at', 'last_human_view_at'];
    const QUERY = ['query_hash', 'query_text', 'searches', 'zero_results', 'click_through', 'mean_clicked_rank', 'last_searched_at'];
    switch (report) {
      case 'pages-top':
        return {
          columns: ['document_id', 'title', 'views', 'unique_readers', 'median_read_ms'],
          rows: (await this.topPages(filter, EXPORT_LIMIT)).map((p) => [p.documentId, p.title, p.views, p.uniqueReaders, p.medianReadMs]),
        };
      case 'pages-never-read':
        return {
          columns: QUIET,
          rows: (await this.collectingSince(workspaceId)) ? (await this.quietPages(scope, null, 'never', to, EXPORT_LIMIT)).map(quiet) : [],
        };
      case 'pages-dead':
        return { columns: QUIET, rows: (await this.quietPages(scope, null, 'dead', deadSince, EXPORT_LIMIT)).map(quiet) };
      case 'search-top':
      case 'search-zero-result':
      case 'search-no-click': {
        const kind = report === 'search-top' ? 'top' : report === 'search-zero-result' ? 'zero' : 'no-click';
        return { columns: QUERY, rows: (await this.queryGroups(workspaceId, from, traffic, kind, EXPORT_LIMIT)).map(queries) };
      }
      case 'agents-tools':
        return {
          columns: ['tool', 'calls', 'errors', 'median_ms'],
          rows: (await this.tools(workspaceId, from, EXPORT_LIMIT)).map((r) => [r.tool, r.calls, r.errors, r.medianMs]),
        };
      case 'agents-keys':
        return {
          columns: ['api_key_id', 'name', 'prefix', 'mcp_calls', 'views', 'searches'],
          rows: (await this.keys(workspaceId, from, EXPORT_LIMIT)).map((r) => [r.apiKeyId, r.name, r.prefix, r.mcpCalls, r.views, r.searches]),
        };
      case 'agents-operations':
        return { columns: ['operation', 'calls'], rows: (await this.operations(workspaceId, from)).map((r) => [r.operation, r.calls]) };
    }
  }

  private async window(workspaceId: string, days: number, traffic: AnalyticsTrafficFilter): Promise<AnalyticsWindow> {
    const to = new Date();
    const from = new Date(to.getTime() - clampDays(days) * DAY_MS);
    return { from: from.toISOString(), to: to.toISOString(), traffic, collectingSince: await this.collectingSince(workspaceId) };
  }

  private async pageLists(scope: AccessScope, filter: ViewFilter, w: AnalyticsWindow, limit: number): Promise<AnalyticsPageLists> {
    const to = new Date(w.to);
    const deadAfterDays = this.config.get('ANALYTICS_DEAD_PAGE_DAYS', { infer: true });
    const projectId = filter.projectId ?? null;
    const [topPages, neverRead, dead] = await Promise.all([
      this.topPages(filter, limit),
      // Before the first view, every page is "never read" — which says nothing.
      w.collectingSince ? this.quietPages(scope, projectId, 'never', to, limit) : [],
      this.quietPages(scope, projectId, 'dead', new Date(to.getTime() - deadAfterDays * DAY_MS), limit),
    ]);
    return { topPages, neverRead, dead, deadAfterDays };
  }

  /**
   * Searches grouped by query hash. `top`: the most searched. `zero`: those
   * that found nothing. `no-click`: web searches that found results nobody
   * opened — only the app can click, so other channels never land here.
   */
  private async queryGroups(
    workspaceId: string,
    from: Date,
    traffic: AnalyticsTrafficFilter,
    kind: 'top' | 'zero' | 'no-click',
    limit: number,
  ): Promise<AnalyticsQueryRow[]> {
    const having =
      kind === 'top' ? Prisma.sql`TRUE` : kind === 'zero' ? Prisma.sql`g.zero > 0` : Prisma.sql`g.web_hits > 0 AND g.clicks = 0`;
    const order = kind === 'zero' ? Prisma.sql`g.zero DESC` : kind === 'no-click' ? Prisma.sql`g.web_hits DESC` : Prisma.sql`g.searches DESC`;
    const rows = await this.prisma.$queryRaw<
      Array<{ query_hash: string; text: string | null; searches: number; zero: number; web_hits: number; clicks: number; mean_rank: number | null; last_at: Date }>
    >`
      WITH ${searchCtesSql(workspaceId, from, traffic)}
      SELECT g.* FROM (
        SELECT s.query_hash,
               (array_agg(s.query_text ORDER BY s.created_at DESC) FILTER (WHERE s.query_text IS NOT NULL))[1] AS text,
               count(*) FILTER (WHERE s.kept)::int AS searches,
               count(*) FILTER (WHERE s.kept AND s.result_count = 0)::int AS zero,
               count(*) FILTER (WHERE s.kept AND s.channel = 'web' AND s.result_count > 0)::int AS web_hits,
               count(c.search_id) FILTER (WHERE s.channel = 'web')::int AS clicks,
               avg(c.rank)::float AS mean_rank,
               max(s.created_at) AS last_at
          FROM s LEFT JOIN c ON c.search_id = s.id
         GROUP BY s.query_hash
      ) g
       WHERE g.searches > 0 AND ${having}
       ORDER BY ${order}, g.last_at DESC, g.query_hash ASC
       LIMIT ${limit}`;
    return rows.map((r) => ({
      queryHash: r.query_hash,
      queryText: r.text,
      searches: r.searches,
      zeroResults: r.zero,
      clickThrough: rate(r.clicks, r.web_hits),
      meanClickedRank: r.mean_rank === null ? null : Math.round(r.mean_rank * 10) / 10,
      lastSearchedAt: r.last_at.toISOString(),
    }));
  }

  private async tools(workspaceId: string, from: Date, limit: number): Promise<AnalyticsToolRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ tool: string; calls: number; errors: number; median: number | null }>>`
      SELECT tool, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS errors,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median
        FROM mcp_tool_calls
       WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${from}::timestamptz
       GROUP BY tool ORDER BY calls DESC, tool ASC
       LIMIT ${limit}`;
    return rows.map((r) => ({ tool: r.tool, calls: r.calls, errors: r.errors, medianMs: r.median === null ? null : Math.round(r.median) }));
  }

  /** What each API key did here: MCP calls, page reads and searches. Name and prefix only. */
  private async keys(workspaceId: string, from: Date, limit: number): Promise<AnalyticsKeyRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; name: string | null; prefix: string | null; mcp: number; views: number; searches: number }>
    >`
      SELECT e.api_key_id AS id, k.name, k.prefix,
             count(*) FILTER (WHERE e.kind = 'mcp')::int AS mcp,
             count(*) FILTER (WHERE e.kind = 'view')::int AS views,
             count(*) FILTER (WHERE e.kind = 'search')::int AS searches
        FROM (
          SELECT api_key_id, 'mcp' AS kind FROM mcp_tool_calls
           WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${from}::timestamptz AND api_key_id IS NOT NULL
          UNION ALL
          SELECT api_key_id, 'view' FROM page_views
           WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${from}::timestamptz AND api_key_id IS NOT NULL
          UNION ALL
          SELECT api_key_id, 'search' FROM search_queries
           WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${from}::timestamptz AND api_key_id IS NOT NULL
        ) e LEFT JOIN api_keys k ON k.id = e.api_key_id
       GROUP BY e.api_key_id, k.name, k.prefix
       ORDER BY count(*) DESC, k.name ASC NULLS LAST
       LIMIT ${limit}`;
    return rows.map((r) => ({ apiKeyId: r.id, name: r.name, prefix: r.prefix, mcpCalls: r.mcp, views: r.views, searches: r.searches }));
  }

  /** Model calls by AI usage operation — the closed `AiUsageOperation` set, so never long. */
  private operations(workspaceId: string, from: Date): Promise<AnalyticsOperationRow[]> {
    return this.prisma.$queryRaw`
      SELECT operation, count(*)::int AS calls FROM ai_usage
       WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${from}::timestamptz
       GROUP BY operation ORDER BY calls DESC, operation ASC`;
  }

  /** Questions asked of the assistant per UTC day: its existing user turns, no new write. */
  private questionSeries(workspaceId: string, from: Date): Promise<Array<{ date: string; count: number }>> {
    return this.prisma.$queryRaw`
      SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date, count(*)::int AS count
        FROM assistant_messages m JOIN assistant_threads th ON th.id = m.thread_id
       WHERE th.workspace_id = ${workspaceId}::uuid AND m.role = 'user' AND m.created_at >= ${from}::timestamptz
       GROUP BY 1 ORDER BY 1`;
  }

  /** The workspace's first recorded view: before it, an empty chart is missing data, not silence. */
  private async collectingSince(workspaceId: string): Promise<string | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ at: Date | null }>>`
      SELECT min(created_at) AS at FROM page_views WHERE workspace_id = ${workspaceId}::uuid`;
    return row?.at?.toISOString() ?? null;
  }

  private async totals(f: ViewFilter): Promise<AnalyticsViewTotals> {
    const [rows, series] = await Promise.all([
      this.prisma.$queryRaw<TotalsRow[]>`
        SELECT count(*)::int AS views, ${classCountsSql()},
               count(DISTINCT pv.reader_key)::int AS readers, ${medianReadSql()} AS median
          FROM page_views pv JOIN documents d ON d.id = pv.document_id
         WHERE ${viewWhereSql(f)}`,
      this.prisma.$queryRaw<AnalyticsDayPoint[]>`
        SELECT to_char(date_trunc('day', pv.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date, ${classCountsSql()}
          FROM page_views pv JOIN documents d ON d.id = pv.document_id
         WHERE ${viewWhereSql(f)}
         GROUP BY 1 ORDER BY 1`,
    ]);
    const r = rows[0];
    return {
      views: r?.views ?? 0,
      byClass: { human: r?.human ?? 0, assisted: r?.assisted ?? 0, agent: r?.agent ?? 0 },
      uniqueReaders: r?.readers ?? 0,
      medianReadMs: r?.median === null || r?.median === undefined ? null : Math.round(r.median),
      series,
    };
  }

  private async topPages(f: ViewFilter, limit: number): Promise<AnalyticsPageRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; title: string; views: number; readers: number; median: number | null }>>`
      SELECT d.id, d.title, count(*)::int AS views, count(DISTINCT pv.reader_key)::int AS readers, ${medianReadSql()} AS median
        FROM page_views pv JOIN documents d ON d.id = pv.document_id
       WHERE ${viewWhereSql(f)}
       GROUP BY d.id, d.title
       ORDER BY views DESC, d.title ASC
       LIMIT ${limit}`;
    return rows.map((r) => ({
      documentId: r.id,
      title: r.title,
      views: r.views,
      uniqueReaders: r.readers,
      medianReadMs: r.median === null ? null : Math.round(r.median),
    }));
  }

  /**
   * Live pages of the project (or, with none, the workspace) nobody reads.
   * `never`: no human view on record. `dead`: the knowledge-health predicate,
   * with `since` its window start.
   */
  private async quietPages(
    scope: AccessScope,
    projectId: string | null,
    kind: 'never' | 'dead',
    since: Date,
    limit: number,
  ): Promise<AnalyticsQuietPage[]> {
    const { workspaceId } = scope;
    const quiet = kind === 'never' ? Prisma.sql`r.last_read_at IS NULL` : quietPageSql('r', since, 'dead');
    const rows = await this.prisma.$queryRaw<Array<{ id: string; title: string; created_at: Date; last_read_at: Date | null }>>`
      SELECT r.id, r.title, r.created_at, r.last_read_at FROM (
        SELECT d.id, d.title, d.created_at, ${readSignalsColumnsSql(workspaceId, since)}
          FROM documents d ${readSignalsJoinSql(workspaceId, 'd', since)}
         WHERE d.workspace_id = ${workspaceId}::uuid AND d.archived_at IS NULL
           AND ${projectId ? Prisma.sql`d.project_id = ${projectId}::uuid` : Prisma.sql`TRUE`}
           AND ${listedSql('d')} AND ${visibilitySql(scope, 'd')}
      ) r
       WHERE ${quiet}
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT ${limit}`;
    return rows.map((r) => ({
      documentId: r.id,
      title: r.title,
      createdAt: r.created_at.toISOString(),
      lastHumanViewAt: r.last_read_at?.toISOString() ?? null,
    }));
  }
}

/** `part ÷ whole`, or null when there is nothing to divide — a rate of nothing is not 0 %. */
function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.min(1, part / whole) : null;
}

/**
 * The CTEs every search rollup reads. `s`: the window's searches, each
 * `kept` unless the same reader ran the same query within REPEAT_SECONDS
 * before — filter toggles re-run a search, and that is one intent, collapsed
 * here at read time. Searches with no reader key cannot be told apart, so
 * each counts. `c`: the first result click of each search, with its rank.
 */
function searchCtesSql(workspaceId: string, from: Date, traffic: AnalyticsTrafficFilter): Prisma.Sql {
  const channel =
    traffic === 'all' ? Prisma.sql`TRUE` : Prisma.sql`sq.channel IN (${Prisma.join(channelsForTrafficClass(traffic))})`;
  return Prisma.sql`
    s AS (
      SELECT sq.id, sq.query_hash, sq.query_text, sq.result_count, sq.channel, sq.created_at,
             (sq.reader_key IS NULL OR lag(sq.created_at) OVER w IS NULL
               OR sq.created_at - lag(sq.created_at) OVER w > make_interval(secs => ${REPEAT_SECONDS})) AS kept
        FROM search_queries sq
       WHERE sq.workspace_id = ${workspaceId}::uuid AND sq.created_at >= ${from}::timestamptz AND ${channel}
      WINDOW w AS (PARTITION BY sq.reader_key, sq.query_hash ORDER BY sq.created_at)
    ),
    c AS (
      SELECT search_id, min(search_rank) AS rank FROM page_views
       WHERE workspace_id = ${workspaceId}::uuid AND search_id IS NOT NULL AND created_at >= ${from}::timestamptz
       GROUP BY search_id
    )`;
}

function clampDays(days: number): number {
  return Math.min(Math.max(Math.trunc(days) || ANALYTICS_DEFAULT_DAYS, 1), ANALYTICS_MAX_DAYS);
}

/** `human`, `assisted`, `agent` view counts, one FILTER per class. */
function classCountsSql(): Prisma.Sql {
  return Prisma.join(
    TRAFFIC_CLASSES.map(
      (c) =>
        Prisma.sql`count(*) FILTER (WHERE pv.channel IN (${Prisma.join(channelsForTrafficClass(c))}))::int AS ${Prisma.raw(c)}`,
    ),
  );
}

/** Median read time: web views only (nothing else measures it), and only those that read for any time at all. */
function medianReadSql(): Prisma.Sql {
  return Prisma.sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY pv.active_ms) FILTER (WHERE pv.channel = 'web' AND pv.active_ms > 0)`;
}

function viewWhereSql(f: ViewFilter): Prisma.Sql {
  const parts = [Prisma.sql`pv.workspace_id = ${f.workspaceId}::uuid`, Prisma.sql`pv.created_at >= ${f.from}::timestamptz`];
  if (f.traffic !== 'all') parts.push(Prisma.sql`pv.channel IN (${Prisma.join(channelsForTrafficClass(f.traffic))})`);
  if (f.documentId) parts.push(Prisma.sql`pv.document_id = ${f.documentId}::uuid`);
  if (f.projectId) parts.push(Prisma.sql`d.project_id = ${f.projectId}::uuid`);
  if (f.scope) parts.push(listedSql('d'), visibilitySql(f.scope, 'd'));
  return Prisma.join(parts, ' AND ');
}
