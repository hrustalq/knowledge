import { Injectable } from '@nestjs/common';
import type { AssistantSource, SearchResult, SourceProvenance, SourceVerificationState } from '@knowledge/contracts';
import { isWebSource, OPEN_KNOWLEDGE_ISSUE_STATUSES, verificationStateFor } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * What one page is worth as evidence, resolved from PostgreSQL in one batch.
 * Everything a reader checks before trusting a citation: the head revision and
 * its author, when it last changed, and whether anyone has stamped it.
 */
export interface DocumentProvenance {
  documentId: string;
  headRevisionId: string | null;
  revisionNumber: number | null;
  authorId: string | null;
  authorName: string | null;
  changedAt: string | null;
  verification: SourceVerificationState;
  verifiedAt: string | null;
  verifiedByName: string | null;
}

/**
 * Provenance for cited pages (docs/features/38, issue #67 phase 1).
 *
 * Resolved **once per answer**, at the end of the turn, not once per tool call:
 * a turn that searched four times would otherwise read the same head revision
 * four times, and the head can move between the first search and the answer —
 * what the reader should see is the page as it stands when the answer lands.
 *
 * Two consumers, one lookup: the assistant decorates its `sources` with it, and
 * `knowledge_search` over MCP decorates its hits, so an agent reads the same
 * freshness a person does.
 *
 * Lives in `FeedbackCoreModule` (controller-free, both processes) rather than
 * beside the assistant because the open-report count (phase 3) is read here,
 * and that table belongs to the feedback area.
 */
@Injectable()
export class ProvenanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Provenance for a set of pages. Ids that are not in `workspaceId` are
   * simply absent from the result — a model-supplied id never widens the
   * pinned workspace, and the caller drops what it cannot resolve.
   */
  async forDocuments(workspaceId: string, documentIds: readonly string[]): Promise<Map<string, DocumentProvenance>> {
    const ids = [...new Set(documentIds)].filter(Boolean);
    const out = new Map<string, DocumentProvenance>();
    if (ids.length === 0) return out;

    const docs = await this.prisma.document.findMany({
      where: { id: { in: ids }, workspaceId },
      select: {
        id: true,
        defaultBranch: true,
        verifiedAt: true,
        verifiedBy: true,
        verifiedRevisionId: true,
        branches: { select: { name: true, headRevisionId: true } },
      },
    });
    const headIds = docs
      .map((d) => d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null)
      .filter((id): id is string => !!id);
    const revisions = headIds.length
      ? await this.prisma.documentRevision.findMany({
          where: { id: { in: headIds } },
          select: { id: true, revisionNumber: true, authorId: true, finalizedAt: true, createdAt: true },
        })
      : [];
    const revById = new Map(revisions.map((r) => [r.id, r]));

    const userIds = new Set<string>();
    for (const r of revisions) userIds.add(r.authorId);
    for (const d of docs) if (d.verifiedBy) userIds.add(d.verifiedBy);
    const users = userIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));
    const openIssues = await this.openIssueCounts(docs.map((d) => d.id));

    for (const d of docs) {
      const headId = d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null;
      const head = headId ? revById.get(headId) : undefined;
      out.set(d.id, {
        documentId: d.id,
        headRevisionId: headId,
        revisionNumber: head?.revisionNumber ?? null,
        authorId: head?.authorId ?? null,
        // The dev principal and deleted accounts have no users row: the id is
        // still reported so the UI can draw initials, the name is simply null.
        authorName: head ? (nameById.get(head.authorId) ?? null) : null,
        changedAt: (head?.finalizedAt ?? head?.createdAt)?.toISOString() ?? null,
        verification: verificationStateFor(d, headId, openIssues.get(d.id) ?? 0),
        verifiedAt: d.verifiedAt?.toISOString() ?? null,
        verifiedByName: d.verifiedBy ? (nameById.get(d.verifiedBy) ?? null) : null,
      });
    }
    return out;
  }

  /**
   * Open reports per page (docs/features/38, phase 3) — what turns a stamp
   * into `flagged`. One grouped count for the batch; a page with none is
   * simply absent.
   */
  async openIssueCounts(documentIds: readonly string[]): Promise<Map<string, number>> {
    if (documentIds.length === 0) return new Map();
    const rows = await this.prisma.knowledgeIssue.groupBy({
      by: ['documentId'],
      where: { documentId: { in: [...documentIds] }, status: { in: [...OPEN_KNOWLEDGE_ISSUE_STATUSES] } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.documentId, r._count._all]));
  }

  /** The optional fields a `SourceProvenance` consumer reads, from one record. */
  static fields(p: DocumentProvenance): SourceProvenance {
    return {
      ...(p.headRevisionId ? { revisionId: p.headRevisionId } : {}),
      ...(p.revisionNumber !== null ? { revisionNumber: p.revisionNumber } : {}),
      ...(p.authorId ? { authorId: p.authorId } : {}),
      ...(p.authorName ? { authorName: p.authorName } : {}),
      ...(p.changedAt ? { changedAt: p.changedAt } : {}),
      verification: p.verification,
      ...(p.verifiedAt ? { verifiedAt: p.verifiedAt } : {}),
      ...(p.verifiedByName ? { verifiedByName: p.verifiedByName } : {}),
    };
  }

  /**
   * Decorate an answer's sources. Web sources pass through untouched; a page
   * source that does not resolve in this workspace is dropped — it should never
   * have been collected, and keeping it would cite a page the reader cannot open.
   *
   * A source that already carries a `revisionId` from search keeps it when it
   * matches the head, and is corrected to the head when it does not: the
   * citation says what the reader will open, which is the head.
   */
  async decorateSources(workspaceId: string, sources: readonly AssistantSource[]): Promise<AssistantSource[]> {
    const pages = sources.filter((s) => !isWebSource(s));
    const map = await this.forDocuments(
      workspaceId,
      pages.map((s) => (s as { documentId: string }).documentId),
    );
    const out: AssistantSource[] = [];
    for (const s of sources) {
      if (isWebSource(s)) {
        out.push(s);
        continue;
      }
      const p = map.get(s.documentId);
      if (!p) continue;
      out.push({
        ...s,
        ...ProvenanceService.fields(p),
        // Page text read directly is an explicit fact; a graph-reached page
        // already says how it was reached.
        factClass: s.factClass ?? 'explicit',
      });
    }
    return out;
  }

  /** Decorate search hits the same way, for `knowledge_search` over MCP. */
  async decorateResults(
    workspaceId: string,
    results: readonly SearchResult[],
  ): Promise<Array<SearchResult & SourceProvenance>> {
    const map = await this.forDocuments(
      workspaceId,
      results.map((r) => r.documentId),
    );
    return results.map((r) => {
      const p = map.get(r.documentId);
      return p ? { ...r, ...ProvenanceService.fields(p), revisionId: r.revisionId, factClass: 'explicit' as const } : r;
    });
  }
}
