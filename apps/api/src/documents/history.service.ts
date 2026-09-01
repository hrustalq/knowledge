import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  FactTimelineEntry,
  FactTimelineResponse,
  FactsAtResponse,
  HistoricalFact,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService, type DocumentRelation } from '../graph/graph.service.js';

/**
 * Phase 5 historical queries (plan.md §11): "what did the KB state at
 * revision r?", fact introduction points, and removed-facts audits.
 *
 * Model: every indexed revision carries its complete revision-scoped fact set
 * (frontmatter + inferred edges keep their asserting revisionId forever;
 * reindexing only replaces edges of the SAME revision). So the snapshot at
 * revision `r` is the edge set of the newest ancestor (including r itself)
 * that asserted revision-scoped facts. Explicit/curated facts are document-
 * level, not revision-versioned; they are included when their anchoring
 * revision is inside the ancestry (or when they have no anchor at all).
 */
@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
  ) {}

  async factsAt(documentId: string, atRevisionId: string): Promise<FactsAtResponse> {
    const { document, byId } = await this.loadDag(documentId);
    if (!byId.has(atRevisionId)) {
      throw new NotFoundException(`Revision ${atRevisionId} not found on document ${documentId}`);
    }
    const ancestors = this.ancestorSet(byId, atRevisionId);
    const rels = await this.graph.getDocumentRelations(document.workspaceId, documentId);

    const revScoped = rels.filter(
      (r) =>
        r.revisionId !== null &&
        ancestors.has(r.revisionId) &&
        (r.extractor === 'frontmatter' || r.extractor === 'inferred'),
    );
    const effectiveRevisionId =
      revScoped.length > 0
        ? revScoped
            .map((r) => r.revisionId as string)
            .reduce((a, b) =>
              (byId.get(a)?.revisionNumber ?? 0) >= (byId.get(b)?.revisionNumber ?? 0) ? a : b,
            )
        : null;
    const snapshot = revScoped.filter((r) => r.revisionId === effectiveRevisionId);

    const docLevel = rels.filter(
      (r) =>
        (r.extractor === 'explicit' || r.extractor === 'curated') &&
        (r.revisionId === null || ancestors.has(r.revisionId)),
    );

    return {
      documentId,
      atRevisionId,
      effectiveRevisionId,
      facts: [...snapshot, ...docLevel].map((r) => this.toFact(r)),
    };
  }

  /**
   * Per-fact lifecycle along a branch's ancestry: when each fact was
   * introduced and — for facts a later revision stopped asserting — when it
   * was removed (the plan.md §11 removed-facts audit).
   */
  async timeline(documentId: string, branchName?: string): Promise<FactTimelineResponse> {
    const { document, byId } = await this.loadDag(documentId);
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: branchName ?? document.defaultBranch } },
    });
    if (!branch) {
      throw new NotFoundException(
        `Branch ${branchName ?? document.defaultBranch} not found on document ${documentId}`,
      );
    }

    const rels = await this.graph.getDocumentRelations(document.workspaceId, documentId);
    const entries: FactTimelineEntry[] = [];

    const chain = branch.headRevisionId
      ? [...this.ancestorSet(byId, branch.headRevisionId)]
          .map((id) => byId.get(id)!)
          .sort((a, b) => a.revisionNumber - b.revisionNumber)
      : [];
    const chainIds = new Set(chain.map((r) => r.id));

    // Revision-scoped facts: group by (type, target, extractor), walk the chain.
    const revScoped = rels.filter(
      (r) =>
        r.revisionId !== null &&
        chainIds.has(r.revisionId) &&
        (r.extractor === 'frontmatter' || r.extractor === 'inferred'),
    );
    const assertingRevs = [...new Set(revScoped.map((r) => r.revisionId as string))]
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.revisionNumber - b.revisionNumber);

    const byFact = new Map<string, DocumentRelation[]>();
    for (const r of revScoped) {
      const key = `${r.type} ${r.targetKey} ${r.extractor}`;
      byFact.set(key, [...(byFact.get(key) ?? []), r]);
    }
    for (const facts of byFact.values()) {
      const revs = facts
        .map((f) => byId.get(f.revisionId as string)!)
        .sort((a, b) => a.revisionNumber - b.revisionNumber);
      const introduced = revs[0];
      const last = revs[revs.length - 1];
      // Removed when a LATER chain revision asserted facts without this one.
      const removedIn = assertingRevs.find((rev) => rev.revisionNumber > last.revisionNumber) ?? null;
      const sample = facts[0];
      entries.push({
        type: sample.type,
        targetKey: sample.targetKey,
        extractor: sample.extractor,
        status: removedIn ? 'removed' : 'active',
        introducedInRevisionId: introduced.id,
        introducedAt: introduced.finalizedAt?.toISOString() ?? null,
        removedInRevisionId: removedIn?.id ?? null,
        removedAt: removedIn?.finalizedAt?.toISOString() ?? null,
      });
    }

    // Document-level facts (explicit/curated): active until explicitly deleted.
    for (const r of rels.filter((x) => x.extractor === 'explicit' || x.extractor === 'curated')) {
      const anchor = r.revisionId ? byId.get(r.revisionId) : undefined;
      entries.push({
        type: r.type,
        targetKey: r.targetKey,
        extractor: r.extractor,
        status: 'active',
        introducedInRevisionId: anchor?.id ?? null,
        introducedAt: anchor?.finalizedAt?.toISOString() ?? null,
        removedInRevisionId: null,
        removedAt: null,
      });
    }

    entries.sort((a, b) => a.type.localeCompare(b.type) || a.targetKey.localeCompare(b.targetKey));
    return { documentId, branch: branch.name, entries };
  }

  private toFact(r: DocumentRelation): HistoricalFact {
    return {
      type: r.type,
      targetKey: r.targetKey,
      entityType: r.entityType,
      name: r.name,
      extractor: r.extractor,
      confidence: r.confidence,
      assertedByRevisionId: r.revisionId,
    };
  }

  private async loadDag(documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);
    const revisions = await this.prisma.documentRevision.findMany({
      where: { documentId },
      include: { parents: { orderBy: { parentOrder: 'asc' } } },
    });
    return { document, byId: new Map(revisions.map((r) => [r.id, r])) };
  }

  /** Ancestor set (including the start revision) over revision_parents. */
  private ancestorSet(
    byId: Map<string, { parents: Array<{ parentRevisionId: string }> }>,
    start: string,
  ): Set<string> {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const p of byId.get(id)?.parents ?? []) queue.push(p.parentRevisionId);
    }
    return seen;
  }
}
