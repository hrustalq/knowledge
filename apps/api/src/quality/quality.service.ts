import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  QUALITY_BANDS,
  QUALITY_DIMENSIONS,
  qualityBand,
  type DocumentQualityResponse,
  type QualityDimension,
  type QualityDimensionMean,
  type QualityDimensionScores,
  type QualityDuplicate,
  type QualityHistoryPoint,
  type QualityIssue,
  type QualityListResponse,
  type QualityPageRow,
  type QualityRuleCount,
  type QualityScore,
  type QualitySort,
  type QualitySummaryResponse,
} from '@knowledge/contracts';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { listedSql } from '../common/listed-page.js';
import { canSee, visibilitySql, type AccessScope } from '../permissions/access-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';

/** Pages on the summary's worst list. */
const WORST = 10;
/** Rules on the summary's most-violated list. */
const TOP_RULES = 10;
/** Audit days on a history line. */
const HISTORY_DAYS = 90;
const LIST_MAX = 100;

export interface QualityListQuery {
  projectId?: string;
  sort?: QualitySort;
  q?: string;
  limit?: number;
  cursor?: string;
}

/** A page's newest score joined to the page, as the SQL returns it. */
interface LatestRow {
  documentId: string;
  projectId: string;
  title: string;
  head: string | null;
  revisionId: string;
  overall: number;
  dimensions: QualityDimensionScores;
  issues: QualityIssue[];
  createdAt: Date;
}

/**
 * The read side of the docs quality scores (#74, phase 5): the Quality tab of
 * knowledge health, the page rail and `knowledge_get_page_quality`.
 *
 * Every figure is each page's **newest** `document_quality_scores` row, picked
 * at read time with one `DISTINCT ON` — the rows are the history, and there is
 * no stored aggregate to disagree with them. Pages count when the auditor
 * would score them: listed, unarchived pages the caller may open, so a
 * restricted page's score moves no number its reader cannot see.
 */
@Injectable()
export class QualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: AiSkillsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get lowThreshold(): number {
    return this.config.get('QUALITY_FINDING_THRESHOLD', { infer: true });
  }

  async summary(scope: AccessScope, projectId?: string): Promise<QualitySummaryResponse> {
    const [latest, totalPages, history] = await Promise.all([
      this.latest(scope, { projectId }),
      this.countPages(scope, projectId),
      this.history(scope, { projectId }),
    ]);

    const distribution = QUALITY_BANDS.map(() => 0);
    const sums = new Map<QualityDimension, { sum: number; measured: number }>(
      QUALITY_DIMENSIONS.map((d) => [d, { sum: 0, measured: 0 }]),
    );
    const rules = new Map<string, { count: number; pages: Set<string> }>();
    let total = 0;
    let lastAuditAt: Date | null = null;
    for (const row of latest) {
      total += row.overall;
      distribution[qualityBand(row.overall)] += 1;
      for (const d of QUALITY_DIMENSIONS) {
        const value = row.dimensions[d];
        if (typeof value !== 'number') continue;
        const acc = sums.get(d)!;
        acc.sum += value;
        acc.measured += 1;
      }
      for (const issue of row.issues) {
        if (issue.dimension !== 'style' || !issue.ruleId) continue;
        const acc = rules.get(issue.ruleId) ?? { count: 0, pages: new Set<string>() };
        acc.count += 1;
        acc.pages.add(row.documentId);
        rules.set(issue.ruleId, acc);
      }
      if (!lastAuditAt || row.createdAt > lastAuditAt) lastAuditAt = row.createdAt;
    }

    const dimensions = Object.fromEntries(
      QUALITY_DIMENSIONS.map((d) => {
        const { sum, measured } = sums.get(d)!;
        return [d, { mean: measured ? Math.round(sum / measured) : null, measured } satisfies QualityDimensionMean];
      }),
    ) as Record<QualityDimension, QualityDimensionMean>;

    // A rule id names a rule of whichever styleguide applies to the scope: the
    // project's own when it has one, else the workspace's.
    const styleguide = rules.size ? await this.skills.effectiveStyleguide(scope.workspaceId, projectId ?? null) : null;
    const ruleText = new Map((styleguide?.rules ?? []).map((r) => [r.id, r.text]));
    const topRules: QualityRuleCount[] = [...rules.entries()]
      .map(([ruleId, acc]) => ({ ruleId, text: ruleText.get(ruleId) ?? null, count: acc.count, pages: acc.pages.size }))
      .sort((a, b) => b.count - a.count || b.pages - a.pages || a.ruleId.localeCompare(b.ruleId))
      .slice(0, TOP_RULES);

    return {
      totalPages,
      scoredPages: latest.length,
      average: latest.length ? Math.round(total / latest.length) : null,
      distribution,
      dimensions,
      history,
      worst: [...latest].sort(byWorst).slice(0, WORST).map(toPageRow),
      rules: topRules,
      lastAuditAt: lastAuditAt?.toISOString() ?? null,
      lowThreshold: this.lowThreshold,
    };
  }

  /** The scored pages, sorted and paged; `cursor` is an offset. */
  async list(scope: AccessScope, query: QualityListQuery): Promise<QualityListResponse> {
    const latest = await this.latest(scope, { projectId: query.projectId, q: query.q });
    const sorted = [...latest].sort(SORTS[query.sort ?? 'worst']);
    const limit = Math.min(query.limit ?? 50, LIST_MAX);
    const offset = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
    const rows = sorted.slice(offset, offset + limit).map(toPageRow);
    return {
      rows,
      total: sorted.length,
      nextCursor: offset + limit < sorted.length ? String(offset + limit) : null,
    };
  }

  /**
   * One page's newest score and its history. The caller's access to the page
   * itself is the route's (`@Access('viewer', 'document')`) or the tool's
   * guard; what is filtered here is what the score *names*: a near-duplicate
   * peer the caller may not open is dropped, with the issue pointing at it, so
   * neither its id nor its title leaves.
   */
  async forDocument(scope: AccessScope, documentId: string): Promise<DocumentQualityResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        path: true,
        restrictedBy: true,
        defaultBranch: true,
        branches: { select: { name: true, headRevisionId: true } },
      },
    });
    if (!document || document.workspaceId !== scope.workspaceId || !canSee(scope, document)) {
      throw new NotFoundException(t('error.document.notFoundInWorkspace', { id: documentId }));
    }
    const [row, history] = await Promise.all([
      this.prisma.documentQualityScore.findFirst({ where: { documentId }, orderBy: { createdAt: 'desc' } }),
      this.history(scope, { documentId }),
    ]);
    const head = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? null;
    if (!row) return { documentId, score: null, peers: [], stale: false, history, lowThreshold: this.lowThreshold };

    const duplicates = (row.duplicates ?? []) as unknown as QualityDuplicate[];
    const peerIds = duplicates.map((p) => p.documentId);
    const peerRows = peerIds.length
      ? await this.prisma.document.findMany({
          where: { id: { in: peerIds }, workspaceId: scope.workspaceId, archivedAt: null },
          select: { id: true, title: true, projectId: true, path: true, restrictedBy: true },
        })
      : [];
    const visible = new Map(peerRows.filter((d) => canSee(scope, d)).map((d) => [d.id, d.title]));
    const shown = duplicates.filter((p) => visible.has(p.documentId));
    const issues = ((row.issues ?? []) as unknown as QualityIssue[]).filter((i) => !i.documentId || visible.has(i.documentId));

    const score: QualityScore = {
      id: row.id,
      documentId: row.documentId,
      projectId: row.projectId,
      revisionId: row.revisionId,
      agentRunId: row.agentRunId,
      rubricVersion: row.rubricVersion,
      overall: row.overall,
      dimensions: row.dimensions as unknown as QualityDimensionScores,
      issues,
      duplicates: shown,
      createdAt: row.createdAt.toISOString(),
    };
    return {
      documentId,
      score,
      peers: shown.map((p) => ({ ...p, title: visible.get(p.documentId)! })),
      stale: head !== null && head !== row.revisionId,
      history,
      lowThreshold: this.lowThreshold,
    };
  }

  /** The `pages` CTE: what the auditor scores, narrowed to what the caller may open. */
  private pagesSql(scope: AccessScope, filter: { projectId?: string; documentId?: string; q?: string }): Prisma.Sql {
    const project = filter.projectId ? Prisma.sql`AND d.project_id = ${filter.projectId}::uuid` : Prisma.empty;
    const document = filter.documentId ? Prisma.sql`AND d.id = ${filter.documentId}::uuid` : Prisma.empty;
    const q = filter.q?.trim() ? Prisma.sql`AND d.title ILIKE ${'%' + escapeLike(filter.q.trim()) + '%'}` : Prisma.empty;
    return Prisma.sql`
      SELECT d.id, d.project_id, d.title, b.head_revision_id AS head
        FROM documents d
        LEFT JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch
       WHERE d.workspace_id = ${scope.workspaceId}::uuid ${project} ${document} ${q}
         AND d.kind = 'page'
         AND d.archived_at IS NULL
         AND ${listedSql('d')}
         AND ${visibilitySql(scope, 'd')}`;
  }

  private async latest(scope: AccessScope, filter: { projectId?: string; q?: string }): Promise<LatestRow[]> {
    return this.prisma.$queryRaw<LatestRow[]>(Prisma.sql`
      WITH pages AS (${this.pagesSql(scope, filter)})
      SELECT DISTINCT ON (s.document_id)
             s.document_id AS "documentId", p.project_id AS "projectId", p.title, p.head,
             s.revision_id AS "revisionId", s.overall, s.dimensions, s.issues, s.created_at AS "createdAt"
        FROM document_quality_scores s
        JOIN pages p ON p.id = s.document_id
       WHERE s.workspace_id = ${scope.workspaceId}::uuid
       ORDER BY s.document_id, s.created_at DESC`);
  }

  private async countPages(scope: AccessScope, projectId?: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n FROM (${this.pagesSql(scope, { projectId })}) pages`);
    return row?.n ?? 0;
  }

  /**
   * One point per audit day: the mean of every page's newest score **as of the
   * end of that day**. A run scores only the pages that are due, so the mean of
   * one day's rows alone would be the mean of the pages that changed — this is
   * the corpus as a reader would have found it that evening.
   */
  private async history(scope: AccessScope, filter: { projectId?: string; documentId?: string }): Promise<QualityHistoryPoint[]> {
    const rows = await this.prisma.$queryRaw<Array<{ day: Date; overall: number }>>(Prisma.sql`
      WITH pages AS (${this.pagesSql(scope, filter)}),
      scores AS (
        SELECT s.document_id, s.overall, s.created_at
          FROM document_quality_scores s
          JOIN pages p ON p.id = s.document_id
         WHERE s.workspace_id = ${scope.workspaceId}::uuid
      ),
      days AS (
        SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS day FROM scores ORDER BY day DESC LIMIT ${HISTORY_DAYS}
      )
      SELECT d.day, round(avg(l.overall))::int AS overall
        FROM days d
        CROSS JOIN LATERAL (
          SELECT DISTINCT ON (s.document_id) s.overall
            FROM scores s
           WHERE s.created_at < ((d.day + 1)::timestamp AT TIME ZONE 'UTC')
           ORDER BY s.document_id, s.created_at DESC
        ) l
       GROUP BY d.day
       ORDER BY d.day`);
    return rows.map((r) => ({ date: toDay(r.day), overall: r.overall }));
  }
}

function toPageRow(r: LatestRow): QualityPageRow {
  return {
    documentId: r.documentId,
    projectId: r.projectId,
    title: r.title,
    overall: r.overall,
    dimensions: r.dimensions,
    issueCount: Array.isArray(r.issues) ? r.issues.length : 0,
    stale: r.head !== null && r.head !== r.revisionId,
    scoredAt: r.createdAt.toISOString(),
  };
}

const byWorst = (a: LatestRow, b: LatestRow) => a.overall - b.overall || a.title.localeCompare(b.title);

const SORTS: Record<QualitySort, (a: LatestRow, b: LatestRow) => number> = {
  worst: byWorst,
  best: (a, b) => b.overall - a.overall || a.title.localeCompare(b.title),
  title: (a, b) => a.title.localeCompare(b.title),
  recent: (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.title.localeCompare(b.title),
};

/** A `date` column as `YYYY-MM-DD`, read in UTC (the driver hands back midnight UTC). */
function toDay(day: Date | string): string {
  return typeof day === 'string' ? day.slice(0, 10) : day.toISOString().slice(0, 10);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
