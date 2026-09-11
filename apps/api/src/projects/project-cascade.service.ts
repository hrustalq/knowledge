import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ProjectCascadeCounts } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import { FULLTEXT_PROVIDER, type FulltextProvider } from '../fulltext/fulltext.provider.js';

/**
 * Destroying a project and everything under it.
 *
 * This is the only code in the product that deletes a page. Everything else is
 * additive by design — revisions are immutable, and a page's bytes, graph
 * vertices, chunks, merge requests and discussions all hang off a document row
 * that nothing else ever removes — so the teardown has to be written out in
 * full rather than delegated to a cascade rule. Prisma's schema has no
 * `onDelete: Cascade` on a single relation to Document: five tables hold a real
 * FK (PostgreSQL refuses), and a further eight reference a document with no FK
 * at all, which is worse for being quiet.
 *
 * Ordering is the whole correctness story:
 *
 *  1. Read the ids and the storage keys *first*. After the rows are gone there
 *     is no way to find the objects they pointed at, and orphaned bytes in a
 *     bucket are invisible.
 *  2. Delete the PostgreSQL rows in one transaction, children before parents.
 *  3. Only then delete the external state — object storage, the graph, the
 *     BM25 index.
 *
 * Step 3 comes last on purpose. If external cleanup ran first and the
 * transaction then failed, live rows would point at bytes that no longer exist
 * — a page that renders as an error forever. In this order the only failure
 * mode is orphaned bytes and vertices that nothing references, which is
 * recoverable garbage rather than a broken document. External failures are
 * therefore logged and never rethrown: the delete has already happened, and
 * reporting it as failed would be the lie.
 *
 * API-side only (like `ProjectOverviewService`): it needs storage, the graph
 * and the fulltext provider, none of which belong in `ProjectsCoreModule`,
 * which the worker imports.
 */
@Injectable()
export class ProjectCascadeService {
  private readonly logger = new Logger(ProjectCascadeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    @Inject(FULLTEXT_PROVIDER) private readonly fulltext: FulltextProvider,
  ) {}

  /**
   * What a cascade would destroy.
   *
   * Counted rather than estimated, because these numbers are the argument: the
   * difference between "12 pages" and "12 pages, 300 revisions, 340 stored
   * files" is what tells someone which of the two modes they actually want.
   */
  async preview(projectId: string): Promise<ProjectCascadeCounts> {
    const where = { document: { projectId } };
    const [documents, revisions, attachments, mergeRequests, reviewThreads, pageThreads, workflowRuns] =
      await Promise.all([
        this.prisma.document.count({ where: { projectId } }),
        this.prisma.documentRevision.count({ where }),
        this.prisma.attachment.count({ where }),
        this.prisma.mergeRequest.count({ where }),
        this.prisma.mergeRequestThread.count({ where: { mergeRequest: { document: { projectId } } } }),
        this.prisma.documentThread.count({ where }),
        this.prisma.workflowRun.count({ where: { projectId } }),
      ]);
    return {
      documents,
      revisions,
      attachments,
      mergeRequests,
      discussions: reviewThreads + pageThreads,
      workflowRuns,
      // Each revision stores its source and a normalized JSON beside it; every
      // attachment is one more object.
      storedFiles: revisions * 2 + attachments,
    };
  }

  /** Destroy the project's contents. The project row itself is the caller's to delete. */
  async cascade(projectId: string, workspaceId: string): Promise<ProjectCascadeCounts> {
    const counts = await this.preview(projectId);

    // Read before deleting: these keys and ids are unreachable afterwards.
    const documents = await this.prisma.document.findMany({
      where: { projectId },
      select: { id: true },
    });
    const documentIds = documents.map((d) => d.id);
    if (documentIds.length === 0) return counts;

    await this.cascadeDocuments(documentIds, workspaceId);
    return counts;
  }

  /**
   * Destroy these documents and everything hanging off them.
   *
   * Split out of `cascade` for connector revert (docs/features/26), which has to
   * undo a single imported page. Reusing this rather than writing a second
   * teardown is the point: the ordering above is the whole correctness story,
   * and a second implementation of it would be a second chance to get it wrong.
   *
   * The caller is responsible for deciding that these documents *should* go —
   * this method asks nothing about children, so pass a subtree's ids together
   * or leave orphans behind.
   */
  async cascadeDocuments(documentIds: string[], workspaceId: string): Promise<void> {
    if (documentIds.length === 0) return;

    const revisions = await this.prisma.documentRevision.findMany({
      where: { documentId: { in: documentIds } },
      select: { id: true, s3Key: true },
    });
    const revisionIds = revisions.map((r) => r.id);
    const attachments = await this.prisma.attachment.findMany({
      where: { documentId: { in: documentIds } },
      select: { s3Key: true },
    });

    await this.prisma.$transaction(
      async (tx) => this.deleteRows(tx, documentIds, revisionIds),
      // A project of any size outlives Prisma's 5s default, and a half-applied
      // teardown is exactly what the transaction exists to prevent.
      { timeout: 120_000, maxWait: 15_000 },
    );

    await this.cleanExternal(workspaceId, documentIds, revisionIds, [
      ...revisions.map((r) => r.s3Key),
      // The normalized sibling the worker writes next to every source.
      ...revisions.map((r) => r.s3Key.replace(/source\.md$/, 'normalized.json')),
      ...attachments.map((a) => a.s3Key),
    ]);
  }

  /**
   * Every PostgreSQL row that references these documents, children first.
   *
   * The order is a topological sort of the FKs, not a preference: merge request
   * comments hang off threads, threads off merge requests, merge requests off
   * both the document and its branches, and revisions off branches — so
   * branches can only go once the revisions and merge requests naming them are
   * gone.
   */
  private async deleteRows(
    tx: Prisma.TransactionClient,
    documentIds: string[],
    revisionIds: string[],
  ): Promise<void> {
    const docs = { documentId: { in: documentIds } };
    const mrWhere = { mergeRequest: { documentId: { in: documentIds } } };

    // Merge requests and their discussions.
    await tx.mergeRequestComment.deleteMany({ where: { thread: mrWhere } });
    await tx.mergeRequestThread.deleteMany({ where: mrWhere });
    await tx.mergeRequestReviewer.deleteMany({ where: mrWhere });
    await tx.mergeRequest.deleteMany({ where: docs });

    // Page comments. document_comments cascades from its thread, but the
    // delete is spelled out anyway: relying on a cascade rule to fire inside a
    // teardown that is otherwise explicit is how one gets missed later.
    await tx.documentComment.deleteMany({ where: { thread: docs } });
    await tx.documentThread.deleteMany({ where: docs });

    // The revision DAG. revision_parents references revisions twice (child and
    // parent), so both directions have to clear before the revisions do.
    const revs = { in: revisionIds };
    await tx.revisionParent.deleteMany({ where: { OR: [{ revisionId: revs }, { parentRevisionId: revs }] } });
    // No FK on either of these — they would simply have been left behind.
    await tx.revisionDiff.deleteMany({ where: { OR: [{ fromRevisionId: revs }, { toRevisionId: revs }] } });
    await tx.ingestionJob.deleteMany({ where: { revisionId: revs } });

    await tx.attachment.deleteMany({ where: docs });
    await tx.documentRevision.deleteMany({ where: docs });
    await tx.documentBranch.deleteMany({ where: docs });

    // Referencing tables with no FK. Each would otherwise point at an id that
    // no longer resolves, which is the failure mode this whole method exists
    // to avoid.
    await tx.glossaryExclusion.deleteMany({ where: docs });
    await tx.connectorLink.deleteMany({ where: docs });
    await tx.connectorConflict.deleteMany({ where: docs });
    await tx.notification.deleteMany({ where: docs });
    await tx.notificationSubscription.deleteMany({
      where: { subjectType: 'document', subjectId: { in: documentIds } },
    });
    // Nullable references: the conversation and the term outlive the page they
    // were about, so they are detached rather than deleted.
    await tx.assistantThread.updateMany({ where: docs, data: { documentId: null } });
    await tx.glossaryTerm.updateMany({ where: docs, data: { documentId: null } });
    // An import item is a record of what a sync did, which stays true after the
    // page goes; but it must stop claiming to have produced something, or the
    // run page would offer to revert a page that is already gone.
    await tx.connectorRunItem.updateMany({
      where: docs,
      data: { documentId: null, linkId: null, createdDocument: false },
    });

    await tx.document.deleteMany({ where: { id: { in: documentIds } } });
  }

  /**
   * Object storage, the graph and the BM25 index.
   *
   * Every failure here is logged and swallowed. The rows are already gone, so
   * there is nothing left to be consistent with — what remains is unreferenced
   * garbage, and a 500 at this point would report a completed deletion as a
   * failure and invite a retry that has nothing left to delete.
   */
  private async cleanExternal(
    workspaceId: string,
    documentIds: string[],
    revisionIds: string[],
    objectKeys: string[],
  ): Promise<void> {
    for (const key of objectKeys) {
      // Every version, not just the current one: the bucket is versioned, so an
      // ordinary delete would hide the key behind a marker and leave the bytes.
      await this.storage.purgeObjectVersions(key).catch((e: Error) => {
        this.logger.warn(`orphaned object ${key}: ${e.message}`);
      });
    }
    for (const documentId of documentIds) {
      await this.graph.deleteDocumentGraph(workspaceId, documentId).catch((e: Error) => {
        this.logger.warn(`orphaned graph vertex for ${documentId}: ${e.message}`);
      });
    }
    for (const revisionId of revisionIds) {
      await this.fulltext.deleteRevision(revisionId).catch((e: Error) => {
        this.logger.warn(`orphaned fulltext entry for ${revisionId}: ${e.message}`);
      });
    }
  }
}
