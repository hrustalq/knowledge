import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  HealthBulkAction,
  HealthFilter,
  KnowledgeHealthBulkResponse,
  KnowledgeHealthBulkResult,
  KnowledgeHealthListResponse,
  KnowledgeHealthRow,
  KnowledgeHealthSettingsOverride,
  KnowledgeHealthSettingsResponse,
  KnowledgeHealthSettingsValues,
  KnowledgeHealthSummaryResponse,
  SourceVerificationState,
  VerificationFlag,
} from '@knowledge/contracts';
import { HEALTH_FILTERS, isInactive, OPEN_KNOWLEDGE_ISSUE_STATUSES } from '@knowledge/contracts';
import { DocumentsService } from '../documents/documents.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilitySql, visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { listedSql } from '../common/listed-page.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VerificationPolicyService } from './verification-policy.service.js';
import { VerificationService } from './verification.service.js';

export type HealthSort = 'activity' | 'title';

export interface HealthListQuery {
  projectId?: string;
  filter?: HealthFilter;
  ownerId?: string;
  q?: string;
  sort?: HealthSort;
  cursor?: string;
  limit?: number;
}

export interface HealthBulkInput {
  documentIds: string[];
  action: HealthBulkAction;
  ownerId?: string | null;
  note?: string;
  intervalDays?: number | null;
}

/** One page as the dashboard's SQL sees it. */
interface HealthSqlRow {
  id: string;
  project_id: string;
  title: string;
  owner_id: string | null;
  verified_by: string | null;
  verified_at: Date | null;
  verification_expires_at: Date | null;
  verification_flag: string | null;
  verification_note: string | null;
  last_activity_at: Date;
  archived_at: Date | null;
  body_chars: number | null;
  child_count: number;
  status: SourceVerificationState;
}

/**
 * The knowledge-health dashboard's read side and bulk actions (docs/features/40).
 *
 * The list and the summary are **one SQL shape**: a CTE that derives each
 * page's status the way `verificationStateFor` does in TypeScript, and a
 * filter predicate per `HEALTH_FILTERS` entry on top of it. The two must agree,
 * which is why the CASE below is written as the predicate's mirror, clause for
 * clause, and why `healthFilterSql` is exhaustive over the contracts list — a
 * filter added there with no clause here fails at build, not at runtime.
 *
 * No stored aggregates: the summary is one `count(*) FILTER (WHERE …)` per
 * filter over rows that already exist.
 */
@Injectable()
export class KnowledgeHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: VerificationPolicyService,
    private readonly verification: VerificationService,
    private readonly documents: DocumentsService,
    private readonly permissions: PermissionService,
  ) {}

  async list(access: AccessScope, query: HealthListQuery): Promise<KnowledgeHealthListResponse> {
    const { workspaceId } = access;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const settings = await this.policy.effective(workspaceId);
    const now = new Date();
    const sort: HealthSort = query.sort ?? 'activity';
    const cursor = decodeCursor(query.cursor);

    const order =
      sort === 'title'
        ? Prisma.sql`ORDER BY r.title ASC, r.id ASC`
        : Prisma.sql`ORDER BY r.last_activity_at ASC, r.id ASC`;
    const after = cursor
      ? sort === 'title'
        ? Prisma.sql`AND (r.title, r.id::text) > (${cursor.v}, ${cursor.id})`
        : Prisma.sql`AND (r.last_activity_at, r.id::text) > (${new Date(cursor.v)}::timestamptz, ${cursor.id})`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<HealthSqlRow[]>`
      WITH r AS (${this.rowsCte(access, query, settings, now)})
      SELECT r.* FROM r
       WHERE ${healthFilterSql(query.filter, settings, now)}
       ${after}
       ${order}
       LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const trails = await this.documents.breadcrumbsFor(
      access,
      page.map((r) => r.id),
    );
    const last = page[page.length - 1];
    return {
      workspaceId,
      rows: page.map((r) => this.toRow(r, trails.get(r.id) ?? '', settings, now)),
      nextCursor:
        hasMore && last
          ? encodeCursor({ v: sort === 'title' ? last.title : last.last_activity_at.toISOString(), id: last.id })
          : null,
    };
  }

  async summary(access: AccessScope, projectId?: string): Promise<KnowledgeHealthSummaryResponse> {
    const { workspaceId } = access;
    const settings = await this.policy.effective(workspaceId);
    const now = new Date();
    const counted = HEALTH_FILTERS.map(
      (f) => Prisma.sql`count(*) FILTER (WHERE ${healthFilterSql(f, settings, now)})::int AS ${Prisma.raw(`"${f}"`)}`,
    );
    const [row] = await this.prisma.$queryRaw<Array<Record<string, number>>>`
      WITH r AS (${this.rowsCte(access, { projectId }, settings, now)})
      SELECT count(*) FILTER (WHERE r.archived_at IS NULL)::int AS total, ${Prisma.join(counted)} FROM r
    `;
    const counts = Object.fromEntries(HEALTH_FILTERS.map((f) => [f, row?.[f] ?? 0])) as Record<HealthFilter, number>;
    return { workspaceId, total: row?.total ?? 0, counts };
  }

  /**
   * One action over many pages. Every id is checked against `workspaceId` in
   * one read **before** anything is written: one foreign id means a 403 and no
   * change at all, with the offending ids in `details.foreign`. Then each page
   * goes through the same single-page method a button would call, and a page
   * that refuses (archived, no head) is reported per id rather than failing
   * the batch — the caller asked about two hundred pages, not one.
   */
  async bulk(access: AccessScope, input: HealthBulkInput, actorId: string): Promise<KnowledgeHealthBulkResponse> {
    const { workspaceId } = access;
    const ids = [...new Set(input.documentIds)];
    // A page the caller may not open is as foreign as another tenant's (#76).
    const owned = await this.prisma.document.findMany({
      where: { id: { in: ids }, workspaceId, AND: [visibilityWhere(access)] },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((d) => d.id));
    const foreign = ids.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      throw new ForbiddenException({
        statusCode: 403,
        message: t('error.document.foreignIds', { count: foreign.length }),
        foreign,
      });
    }
    const results: KnowledgeHealthBulkResult[] = [];
    for (const documentId of ids) {
      try {
        // The single-page routes check edit on the page itself; so does this (#76).
        await this.permissions.requireLevel(access, { type: 'document', id: documentId }, 'edit');
        await this.apply(documentId, input, actorId);
        results.push({ documentId, ok: true });
      } catch (error) {
        results.push({ documentId, ok: false, error: bulkErrorCode(error) });
      }
    }
    return { action: input.action, results };
  }

  private async apply(documentId: string, input: HealthBulkInput, actorId: string): Promise<void> {
    switch (input.action) {
      case 'verify':
        await this.verification.verify(documentId, actorId, { intervalDays: input.intervalDays });
        return;
      case 'request':
        await this.verification.requestVerification(documentId, { actorId, note: input.note });
        return;
      case 'outdated':
        await this.verification.markOutdated(documentId, { actorId, note: input.note });
        return;
      case 'clear':
        await this.verification.clear(documentId, actorId);
        return;
      case 'reassign':
        await this.documents.setOwner(documentId, input.ownerId ?? null, actorId);
        return;
      case 'archive':
        await this.verification.archive(documentId, actorId, true);
        return;
      case 'unarchive':
        await this.verification.unarchive(documentId, actorId, true);
        return;
    }
  }

  async settings(workspaceId: string): Promise<KnowledgeHealthSettingsResponse> {
    const [effective, override] = await Promise.all([this.policy.effective(workspaceId), this.policy.override(workspaceId)]);
    return { workspaceId, effective, override, defaults: this.policy.defaults() };
  }

  async updateSettings(
    workspaceId: string,
    patch: Partial<KnowledgeHealthSettingsOverride>,
  ): Promise<KnowledgeHealthSettingsResponse> {
    await this.policy.update(workspaceId, patch);
    return this.settings(workspaceId);
  }

  /**
   * Every page in scope with its derived status. The CASE is
   * `verificationStateFor`, clause for clause and in the same order; change one
   * and change the other.
   */
  private rowsCte(
    access: AccessScope,
    scope: { projectId?: string; ownerId?: string; q?: string },
    _settings: KnowledgeHealthSettingsValues,
    now: Date,
  ): Prisma.Sql {
    const project = scope.projectId ? Prisma.sql`AND d.project_id = ${scope.projectId}::uuid` : Prisma.empty;
    const owner = scope.ownerId ? Prisma.sql`AND d.owner_id = ${scope.ownerId}::uuid` : Prisma.empty;
    const q = scope.q?.trim() ? Prisma.sql`AND d.title ILIKE ${'%' + escapeLike(scope.q.trim()) + '%'}` : Prisma.empty;
    return Prisma.sql`
      SELECT d.id, d.project_id, d.title, d.owner_id, d.verified_by, d.verified_at, d.verification_expires_at,
             d.verification_flag, d.verification_note, d.last_activity_at, d.archived_at,
             rev.body_chars,
             (SELECT count(*)::int FROM documents c WHERE c.parent_id = d.id AND ${listedSql('c')} AND ${visibilitySql(access, 'c')}) AS child_count,
             CASE
               WHEN d.verification_flag = 'outdated' THEN 'outdated'
               WHEN EXISTS (
                 SELECT 1 FROM knowledge_issues ki
                  WHERE ki.document_id = d.id AND ki.status IN (${Prisma.join([...OPEN_KNOWLEDGE_ISSUE_STATUSES])})
               ) THEN 'flagged'
               WHEN d.verification_flag = 'requested' THEN 'requested'
               WHEN d.verified_revision_id IS NULL THEN 'unverified'
               WHEN b.head_revision_id IS NULL OR b.head_revision_id <> d.verified_revision_id THEN 'edited'
               WHEN d.verification_expires_at IS NOT NULL AND d.verification_expires_at <= ${now}::timestamptz THEN 'expired'
               ELSE 'verified'
             END AS status
        FROM documents d
        LEFT JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch
        LEFT JOIN document_revisions rev ON rev.id = b.head_revision_id
       WHERE d.workspace_id = ${access.workspaceId}::uuid ${project} ${owner} ${q}
         -- Pages the caller may not open are not on the dashboard (#76), nor a
         -- page that is still only a merge request (#73).
         AND ${listedSql('d')}
         AND ${visibilitySql(access, 'd')}
    `;
  }

  private toRow(r: HealthSqlRow, breadcrumb: string, settings: KnowledgeHealthSettingsValues, now: Date): KnowledgeHealthRow {
    return {
      documentId: r.id,
      projectId: r.project_id,
      title: r.title,
      breadcrumb,
      status: r.status,
      ownerId: r.owner_id,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at?.toISOString() ?? null,
      expiresAt: r.verification_expires_at?.toISOString() ?? null,
      lastActivityAt: r.last_activity_at.toISOString(),
      inactive: isInactive(r.last_activity_at, settings.inactiveAfterDays, now),
      empty: r.body_chars === null ? null : r.body_chars <= settings.emptyMaxChars,
      archivedAt: r.archived_at?.toISOString() ?? null,
      childCount: r.child_count,
      verificationFlag: (r.verification_flag as VerificationFlag | null) ?? null,
      verificationNote: r.verification_note,
    };
  }
}

/**
 * The SQL inverse of each `HealthFilter`, over the CTE's columns. Exhaustive by
 * the `switch`'s return type — TypeScript refuses a filter without a clause.
 * Every filter but `archived` is implicitly "and not archived": an archived
 * page is neither stale nor unowned, it is put away.
 */
export function healthFilterSql(
  filter: HealthFilter | undefined,
  settings: KnowledgeHealthSettingsValues,
  now: Date,
): Prisma.Sql {
  const live = Prisma.sql`r.archived_at IS NULL`;
  const inactive =
    settings.inactiveAfterDays > 0
      ? Prisma.sql`r.last_activity_at < ${new Date(now.getTime() - settings.inactiveAfterDays * 86_400_000)}::timestamptz`
      : Prisma.sql`false`;
  switch (filter) {
    case undefined:
      return live;
    case 'archived':
      return Prisma.sql`r.archived_at IS NOT NULL`;
    case 'unowned':
      return Prisma.sql`${live} AND r.owner_id IS NULL`;
    case 'empty':
      return Prisma.sql`${live} AND r.body_chars IS NOT NULL AND r.body_chars <= ${settings.emptyMaxChars}`;
    case 'inactive':
      return Prisma.sql`${live} AND ${inactive}`;
    case 'stale':
      return Prisma.sql`${live} AND (r.status IN ('expired', 'outdated') OR ${inactive})`;
    case 'expired':
    case 'edited':
    case 'outdated':
    case 'requested':
    case 'flagged':
      return Prisma.sql`${live} AND r.status = ${filter}`;
  }
}

/** `details.reason` of a 409, or the status class, as a short per-id code. */
function bulkErrorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const reason = typeof body === 'object' && body && 'reason' in body ? String((body as { reason: unknown }).reason) : '';
    if (reason === 'document_archived') return 'archived';
    if (reason === 'no_head_revision') return 'no-head';
    if (error.getStatus() === 404) return 'not-found';
    if (error.getStatus() === 403) return 'forbidden';
    if (error.getStatus() === 400) return 'invalid';
  }
  return 'failed';
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function encodeCursor(c: { v: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(token?: string): { v: string; id: string } | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { v?: unknown; id?: unknown };
    return typeof parsed.v === 'string' && typeof parsed.id === 'string' ? { v: parsed.v, id: parsed.id } : null;
  } catch {
    return null;
  }
}
