import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { KnowledgeConflict } from '@prisma/client';
import type { ConflictCodeRef, ConflictKind, ConflictStatus, KnowledgeConflictDto } from '@knowledge/contracts';
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
   *
   * `refreshOpen` is the sentinel's (phase 6): its identity is the page and
   * the pull request, and every push re-judges the same claim, so an open row
   * takes the newest judgement — keeping a fix already proposed for it.
   */
  async record(input: {
    workspaceId: string;
    kind: ConflictKind;
    a: DetectedSide;
    b: DetectedSide | null;
    codeRef?: ConflictCodeRef | null;
    /** Identity when it is not the two quotes (the sentinel: page + pull request). */
    fingerprint?: string;
    refreshOpen?: boolean;
    explanation: string;
    confidence: number;
    agentRunId: string | null;
    findingIndex: number | null;
  }): Promise<{ id: string; status: ConflictStatus; written: boolean }> {
    const fingerprint = input.fingerprint ?? conflictFingerprint(input.b ? [input.a, input.b] : [input.a]);
    const refreshOpen = input.refreshOpen === true;
    const b = input.b;
    const codeRef = input.codeRef ? JSON.stringify(input.codeRef) : null;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; status: ConflictStatus }>>`
      INSERT INTO knowledge_conflicts (
        id, workspace_id, kind, status, fingerprint,
        a_document_id, a_revision_id, a_chunk_id, a_quote,
        b_document_id, b_revision_id, b_chunk_id, b_quote, code_ref,
        explanation, confidence, agent_run_id, finding_index)
      VALUES (
        gen_random_uuid(), ${input.workspaceId}::uuid, ${input.kind}, 'open', ${fingerprint},
        ${input.a.documentId}::uuid, ${input.a.revisionId}::uuid, ${input.a.chunkId}, ${input.a.quote},
        ${b?.documentId ?? null}::uuid, ${b?.revisionId ?? null}::uuid, ${b?.chunkId ?? null}, ${b?.quote ?? null}, ${codeRef}::jsonb,
        ${input.explanation}, ${input.confidence}, ${input.agentRunId}::uuid, ${input.findingIndex})
      ON CONFLICT (workspace_id, fingerprint) DO UPDATE SET
        status = 'open',
        a_revision_id = EXCLUDED.a_revision_id, a_chunk_id = EXCLUDED.a_chunk_id, a_quote = EXCLUDED.a_quote,
        b_revision_id = EXCLUDED.b_revision_id, b_chunk_id = EXCLUDED.b_chunk_id,
        code_ref = EXCLUDED.code_ref,
        explanation = EXCLUDED.explanation, confidence = EXCLUDED.confidence,
        agent_run_id = EXCLUDED.agent_run_id, finding_index = EXCLUDED.finding_index,
        -- A superseded row starts over; a refreshed open one keeps its proposed fix.
        merge_request_id = CASE WHEN knowledge_conflicts.status = 'superseded' THEN NULL ELSE knowledge_conflicts.merge_request_id END,
        detected_at = now(), resolved_at = NULL, resolved_by = NULL, resolution = NULL
      WHERE knowledge_conflicts.status = 'superseded' OR (${refreshOpen} AND knowledge_conflicts.status = 'open')
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

  /**
   * The ticket a conflict was handed off for was closed in the tracker (#424).
   * One guarded statement: only an open conflict moves, so a person who
   * already closed it keeps their word. `actor` is null when the tracker
   * account maps to nobody here; the note says where it was closed.
   */
  async closeFromTracker(id: string, status: 'resolved' | 'dismissed', actor: string | null, note: string): Promise<boolean> {
    const row = await this.prisma.knowledgeConflict.findUnique({ where: { id }, select: { workspaceId: true, aDocumentId: true } });
    if (!row) return false;
    const { count } = await this.prisma.knowledgeConflict.updateMany({
      where: { id, status: 'open' },
      data: { status, resolvedAt: new Date(), resolvedBy: actor, resolution: note },
    });
    if (count) await this.publish(row.workspaceId, id, row.aDocumentId);
    return count > 0;
  }

  /**
   * The merge request a fix was proposed as. Called by `AgentFindingsService`
   * when a finding that reported a conflict is proposed — from the conflict,
   * the runs panel or the drift sweeper alike — so all three link it.
   */
  async attachMergeRequest(id: string, mergeRequestId: string): Promise<void> {
    const row = await this.prisma.knowledgeConflict.findUnique({ where: { id }, select: { workspaceId: true, aDocumentId: true } });
    if (!row) return;
    await this.prisma.knowledgeConflict.updateMany({ where: { id, mergeRequestId: null }, data: { mergeRequestId } });
    await this.publish(row.workspaceId, id, row.aDocumentId);
  }

  /**
   * A merge request merged: the open conflicts it was proposed to fix are
   * resolved, attributed to whoever merged it. Returns how many.
   */
  async resolveMerged(mergeRequestId: string, actor: string | null): Promise<number> {
    const rows = await this.prisma.knowledgeConflict.findMany({
      where: { mergeRequestId, status: 'open' },
      select: { id: true, workspaceId: true, aDocumentId: true },
    });
    if (!rows.length) return 0;
    const { count } = await this.prisma.knowledgeConflict.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: 'open' },
      data: { status: 'resolved', resolvedAt: new Date(), resolvedBy: actor },
    });
    for (const r of rows) await this.publish(r.workspaceId, r.id, r.aDocumentId);
    return count;
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
      select: { workspaceId: true, agentRunId: true, findingIndex: true },
    });
  }

  /** Where in its run's findings the finding that reported `conflictId` sits, or null. */
  async findingIndexOf(agentRunId: string, conflictId: string): Promise<number | null> {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId }, select: { findings: true } });
    const findings = Array.isArray(run?.findings) ? (run.findings as Array<{ conflictId?: string }>) : [];
    const index = findings.findIndex((f) => f?.conflictId === conflictId);
    return index >= 0 ? index : null;
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
      b: r.bDocumentId
        ? { documentId: r.bDocumentId, title: title.get(r.bDocumentId)!, revisionId: r.bRevisionId ?? '', chunkId: r.bChunkId, quote: r.bQuote ?? '' }
        : null,
      codeRef: (r.codeRef as ConflictCodeRef | null) ?? null,
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

