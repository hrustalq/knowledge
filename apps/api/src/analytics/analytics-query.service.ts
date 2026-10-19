import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  ANALYTICS_DEFAULT_DAYS,
  ANALYTICS_MAX_DAYS,
  TRAFFIC_CLASSES,
  channelsForTrafficClass,
  type AnalyticsDayPoint,
  type AnalyticsPageRow,
  type AnalyticsQuietPage,
  type AnalyticsTrafficFilter,
  type AnalyticsViewTotals,
  type PageInsightsResponse,
  type ProjectAnalyticsResponse,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { listedSql } from '../common/listed-page.js';
import { visibilitySql, type AccessScope } from '../permissions/access-scope.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HUMAN_CHANNELS, quietPageSql, readSignalsColumnsSql, readSignalsJoinSql } from './read-signals.js';

const DAY_MS = 86_400_000;
/** Rows in each list of the project dashboard: a glance, not a report. */
const LIST_LIMIT = 10;

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
    const to = new Date();
    const from = new Date(to.getTime() - clampDays(days) * DAY_MS);
    const deadAfterDays = this.config.get('ANALYTICS_DEAD_PAGE_DAYS', { infer: true });
    const filter: ViewFilter = { workspaceId: scope.workspaceId, from, traffic, projectId, scope };
    const collectingSince = await this.collectingSince(scope.workspaceId);
    const [totals, topPages, neverRead, dead] = await Promise.all([
      this.totals(filter),
      this.topPages(filter),
      // Before the first view, every page is "never read" — which says nothing.
      collectingSince ? this.quietPages(scope, projectId, 'never', to) : [],
      this.quietPages(scope, projectId, 'dead', new Date(to.getTime() - deadAfterDays * DAY_MS)),
    ]);
    return {
      projectId,
      from: from.toISOString(),
      to: to.toISOString(),
      traffic,
      ...totals,
      topPages,
      neverRead,
      dead,
      deadAfterDays,
      collectingSince,
    };
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

  private async topPages(f: ViewFilter): Promise<AnalyticsPageRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; title: string; views: number; readers: number; median: number | null }>>`
      SELECT d.id, d.title, count(*)::int AS views, count(DISTINCT pv.reader_key)::int AS readers, ${medianReadSql()} AS median
        FROM page_views pv JOIN documents d ON d.id = pv.document_id
       WHERE ${viewWhereSql(f)}
       GROUP BY d.id, d.title
       ORDER BY views DESC, d.title ASC
       LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      documentId: r.id,
      title: r.title,
      views: r.views,
      uniqueReaders: r.readers,
      medianReadMs: r.median === null ? null : Math.round(r.median),
    }));
  }

  /**
   * Live pages of the project nobody reads. `never`: no human view on record.
   * `dead`: the knowledge-health predicate, with `since` its window start.
   */
  private async quietPages(
    scope: AccessScope,
    projectId: string,
    kind: 'never' | 'dead',
    since: Date,
  ): Promise<AnalyticsQuietPage[]> {
    const { workspaceId } = scope;
    const quiet = kind === 'never' ? Prisma.sql`r.last_read_at IS NULL` : quietPageSql('r', since, 'dead');
    const rows = await this.prisma.$queryRaw<Array<{ id: string; title: string; created_at: Date; last_read_at: Date | null }>>`
      SELECT r.id, r.title, r.created_at, r.last_read_at FROM (
        SELECT d.id, d.title, d.created_at, ${readSignalsColumnsSql(workspaceId, since)}
          FROM documents d ${readSignalsJoinSql(workspaceId, 'd', since)}
         WHERE d.workspace_id = ${workspaceId}::uuid AND d.project_id = ${projectId}::uuid AND d.archived_at IS NULL
           AND ${listedSql('d')} AND ${visibilitySql(scope, 'd')}
      ) r
       WHERE ${quiet}
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      documentId: r.id,
      title: r.title,
      createdAt: r.created_at.toISOString(),
      lastHumanViewAt: r.last_read_at?.toISOString() ?? null,
    }));
  }
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
