import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { KnowledgeConflict } from '@prisma/client';
import type { ConflictKind, ConflictStatus, KnowledgeConflictDto } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { conflictFingerprint } from '../agents/contradiction.js';
import { t } from '../i18n/t.js';

/** One side of a conflict as the arbiter found it. */
export interface DetectedSide {
  documentId: string;
  revisionId: string;
  chunkId: string | null;
  quote: string;
}

const LIST_LIMIT = 200;

/**
 * Contradictions between pages (#81): the rows the arbiter writes and people
 * act on. Controller-free, so the worker records and the API reads through the
 * same rules.
 *
 * Every read takes the caller's `AccessScope` and returns a conflict only when
 * the caller may open both pages — a conflict quotes both, so either page being
 * hidden hides the conflict (#76). A refused one is a 404, never a title.
 */
@Injectable()
export class ConflictsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsPublisher,
  ) {}

  /**
   * Record a detected conflict, idempotently: one row per fingerprint. Found
   * again while open, resolved or dismissed, it is left as it is — a dismissed
   * conflict stays dismissed. Found again after it was superseded (a side's
   * page changed), the new text still disagrees, so it reopens against the new
   * revisions. One guarded statement either way.
   */
  async record(input: {
    workspaceId: string;
    kind: ConflictKind;
    a: DetectedSide;
    b: DetectedSide;
    explanation: string;
    confidence: number;
    agentRunId: string | null;
    findingIndex: number | null;
  }): Promise<{ id: string; status: ConflictStatus; written: boolean }> {
    const fingerprint = conflictFingerprint([input.a, input.b]);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; status: ConflictStatus }>>`
      INSERT INTO knowledge_conflicts (
        id, workspace_id, kind, status, fingerprint,
        a_document_id, a_revision_id, a_chunk_id, a_quote,
        b_document_id, b_revision_id, b_chunk_id, b_quote,
        explanation, confidence, agent_run_id, finding_index)
      VALUES (
        gen_random_uuid(), ${input.workspaceId}::uuid, ${input.kind}, 'open', ${fingerprint},
        ${input.a.documentId}::uuid, ${input.a.revisionId}::uuid, ${input.a.chunkId}, ${input.a.quote},
        ${input.b.documentId}::uuid, ${input.b.revisionId}::uuid, ${input.b.chunkId}, ${input.b.quote},
        ${input.explanation}, ${input.confidence}, ${input.agentRunId}::uuid, ${input.findingIndex})
      ON CONFLICT (workspace_id, fingerprint) DO UPDATE SET
        status = 'open',
        a_revision_id = EXCLUDED.a_revision_id, a_chunk_id = EXCLUDED.a_chunk_id,
        b_revision_id = EXCLUDED.b_revision_id, b_chunk_id = EXCLUDED.b_chunk_id,
        explanation = EXCLUDED.explanation, confidence = EXCLUDED.confidence,
        agent_run_id = EXCLUDED.agent_run_id, finding_index = EXCLUDED.finding_index,
        merge_request_id = NULL, detected_at = now(), resolved_at = NULL, resolved_by = NULL, resolution = NULL
      WHERE knowledge_conflicts.status = 'superseded'
      RETURNING id, status`;
    const written = rows[0];
    if (written) {
      await this.publish(input.workspaceId, written.id, input.a.documentId);
      return { ...written, written: true };
    }
    const held = await this.prisma.knowledgeConflict.findUniqueOrThrow({
      where: { workspaceId_fingerprint: { workspaceId: input.workspaceId, fingerprint } },
      select: { id: true, status: true },
    });
    return { id: held.id, status: held.status as ConflictStatus, written: false };
  }

  /**
   * A page's head moved (#81): open conflicts quoting an older revision of it
   * are superseded — the text they quote is no longer what the page says. The
   * arbiter re-detects against the new text when it runs. Returns how many.
   */
  async supersedeStale(workspaceId: string, documentId: string, headRevisionId: string): Promise<number> {
    const { count } = await this.prisma.knowledgeConflict.updateMany({
      where: {
        workspaceId,
        status: 'open',
        OR: [
          { aDocumentId: documentId, aRevisionId: { not: headRevisionId } },
          { bDocumentId: documentId, bRevisionId: { not: headRevisionId } },
        ],
      },
      data: { status: 'superseded' },
    });
    if (count) await this.publish(workspaceId, undefined, documentId);
    return count;
  }

  async list(scope: AccessScope, filter: { status?: ConflictStatus; kind?: ConflictKind; documentId?: string } = {}): Promise<KnowledgeConflictDto[]> {
    const rows = await this.prisma.knowledgeConflict.findMany({
      where: {
        workspaceId: scope.workspaceId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.documentId ? { OR: [{ aDocumentId: filter.documentId }, { bDocumentId: filter.documentId }] } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: LIST_LIMIT,
    });
    return this.visible(scope, rows);
  }

  /** One conflict the caller may see both pages of, or 404. */
  async get(scope: AccessScope, id: string): Promise<KnowledgeConflictDto> {
    const row = await this.prisma.knowledgeConflict.findFirst({ where: { id, workspaceId: scope.workspaceId } });
    const [dto] = row ? await this.visible(scope, [row]) : [];
    if (!dto) throw new NotFoundException(t('error.conflict.notFound', { id }));
    return dto;
  }

  /** Resolve or dismiss an open conflict. A second press, or a superseded one, is a 409. */
  async close(scope: AccessScope, id: string, status: 'resolved' | 'dismissed', actor: string, note?: string): Promise<KnowledgeConflictDto> {
    const before = await this.get(scope, id);
    const { count } = await this.prisma.knowledgeConflict.updateMany({
      where: { id, status: 'open' },
      data: { status, resolvedAt: new Date(), resolvedBy: actor, resolution: note?.trim() || null },
    });
    if (!count) {
      throw new ConflictException({ statusCode: 409, message: t('error.conflict.notOpen'), reason: 'conflict-not-open', status: before.status });
    }
    await this.publish(scope.workspaceId, id, before.a.documentId);
    return this.get(scope, id);
  }

  /** The merge request a fix was proposed as. */
  async markProposed(workspaceId: string, id: string, mergeRequestId: string, documentId: string): Promise<void> {
    await this.prisma.knowledgeConflict.updateMany({ where: { id, mergeRequestId: null }, data: { mergeRequestId } });
    await this.publish(workspaceId, id, documentId);
  }

  /** For the guard: the workspace a conflict id belongs to. */
  async workspaceOf(id: string): Promise<string> {
    const row = await this.prisma.knowledgeConflict.findUnique({ where: { id }, select: { workspaceId: true } });
    if (!row) throw new NotFoundException(t('error.conflict.notFound', { id }));
    return row.workspaceId;
  }

  /** Raw access for the propose route: the run and finding that reported it. */
  async source(id: string) {
    return this.prisma.knowledgeConflict.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true, agentRunId: true, findingIndex: true, mergeRequestId: true, status: true, aDocumentId: true },
    });
  }

  /** Rows whose pages the caller may all open, with PG titles. PG decides (#76). */
  private async visible(scope: AccessScope, rows: KnowledgeConflict[]): Promise<KnowledgeConflictDto[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.aDocumentId, r.bDocumentId].filter((x): x is string => !!x)))];
    if (!ids.length) return [];
    const docs = await this.prisma.document.findMany({
      where: { id: { in: ids }, AND: [visibilityWhere(scope)] },
      select: { id: true, title: true },
    });
    const title = new Map(docs.map((d) => [d.id, d.title]));
    return rows.filter((r) => title.has(r.aDocumentId) && (!r.bDocumentId || title.has(r.bDocumentId))).map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      kind: r.kind as ConflictKind,
      status: r.status as ConflictStatus,
      a: { documentId: r.aDocumentId, title: title.get(r.aDocumentId)!, revisionId: r.aRevisionId, chunkId: r.aChunkId, quote: r.aQuote },
      b: {
        documentId: r.bDocumentId ?? '',
        title: r.bDocumentId ? title.get(r.bDocumentId)! : '',
        revisionId: r.bRevisionId ?? '',
        chunkId: r.bChunkId,
        quote: r.bQuote ?? '',
      },
      explanation: r.explanation,
      confidence: r.confidence,
      agentRunId: r.agentRunId,
      mergeRequestId: r.mergeRequestId,
      detectedAt: r.detectedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolvedBy: r.resolvedBy,
      resolution: r.resolution,
    }));
  }

  private async publish(workspaceId: string, conflictId: string | undefined, documentId: string | undefined): Promise<void> {
    await this.events
      .publish({ type: 'conflict.updated', workspaceId, ...(documentId ? { documentId } : {}), ...(conflictId ? { subjectId: conflictId } : {}) })
      .catch(() => undefined);
  }
}

