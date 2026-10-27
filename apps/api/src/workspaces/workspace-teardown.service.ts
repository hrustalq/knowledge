import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { WorkspaceDeletionCounts } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import { FULLTEXT_PROVIDER, type FulltextProvider } from '../fulltext/fulltext.provider.js';
import { ProjectCascadeService } from '../projects/project-cascade.service.js';
import { WORKSPACE_ROWS } from './workspace-teardown.inventory.js';
import { pruneFigmaGrants } from '../embeds/figma-oauth.service.js';
import { ReadCache } from '../cache/read-cache.service.js';

/** Pages per transaction: each batch commits on its own, so an interrupted teardown resumes where it stopped. */
const PAGE_BATCH = 200;

type WorkspaceDelegate = { deleteMany(args: { where: { workspaceId: string } }): Promise<unknown> };

/**
 * Deleting everything a tombstoned workspace owns (#479), then the row.
 *
 * The same ordering as `ProjectCascadeService`, one level up: read what the
 * rows point at, delete the rows, then clear the external stores, and the
 * `workspaces` row last of all — so until it is gone the tombstone is still
 * there for the next tick to resume from. Every step is a delete by id or by
 * workspace, so running it twice is the same as running it once.
 *
 * Pages go through `cascadeDocuments` rather than a second teardown of the
 * revision DAG; the rest is the `workspace` list of the inventory, in order.
 * External failures are logged and swallowed: the rows are gone, what is left
 * is unreferenced garbage, and nothing can read the workspace any more.
 *
 * API-side only: storage, the graph and BM25 are not the worker's to delete.
 */
@Injectable()
export class WorkspaceTeardownService {
  private readonly logger = new Logger(WorkspaceTeardownService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cascade: ProjectCascadeService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    @Inject(FULLTEXT_PROVIDER) private readonly fulltext: FulltextProvider,
    private readonly cache: ReadCache,
  ) {}

  async preview(workspaceId: string): Promise<WorkspaceDeletionCounts> {
    const where = { workspaceId };
    const [projects, documents, revisions, attachments, connectors, chatBindings, apiKeys, publishedSites] =
      await Promise.all([
        this.prisma.project.count({ where }),
        this.prisma.document.count({ where }),
        this.prisma.documentRevision.count({ where: { document: where } }),
        this.prisma.attachment.count({ where }),
        this.prisma.connector.count({ where }),
        this.prisma.chatChannelBinding.count({ where }),
        this.prisma.apiKey.count({ where: { ...where, revokedAt: null } }),
        this.prisma.publishedSite.count({ where }),
      ]);
    return {
      projects,
      documents,
      revisions,
      storedFiles: revisions * 2 + attachments,
      connectors,
      chatBindings,
      apiKeys,
      publishedSites,
    };
  }

  /** One pass over one tombstone. `true` once the workspace row is gone; `false` leaves it for the next tick. */
  async teardown(workspaceId: string): Promise<boolean> {
    // A job mid-pipeline writes the graph and BM25 after we would clear them.
    // New ones refuse a tombstoned workspace, so this only waits out the last.
    if (await this.prisma.ingestionJob.count({ where: { workspaceId, status: 'running' } })) return false;

    for (;;) {
      const batch = await this.prisma.document.findMany({ where: { workspaceId }, select: { id: true }, take: PAGE_BATCH });
      if (batch.length === 0) break;
      await this.cascade.cascadeDocuments(batch.map((d) => d.id), workspaceId, { external: false });
    }

    // Read before deleting: project avatars live outside the workspace prefix.
    const avatars = await this.prisma.project.findMany({
      where: { workspaceId, avatarKey: { not: null } },
      select: { avatarKey: true },
    });

    await this.prisma.$transaction(
      async (tx) => {
        // The one child whose FK does not cascade and which has no workspace_id.
        await tx.assistantMessage.deleteMany({ where: { thread: { workspaceId } } });
        for (const model of WORKSPACE_ROWS) await delegateOf(tx, model).deleteMany({ where: { workspaceId } });
        // Figma grants belong to no workspace: one this workspace alone referenced goes with its connectors (#557).
        await pruneFigmaGrants(tx);
      },
      // ponytail: one transaction for every event table; batch page_views / chat_messages if a workspace outgrows the timeout.
      { timeout: 300_000, maxWait: 15_000 },
    );

    await this.cleanExternal(workspaceId, avatars.map((p) => p.avatarKey!));

    return this.prisma.$transaction(async (tx) => {
      // A page written after the batches above (a sync already in flight at
      // the tombstone) keeps the tombstone for another pass.
      if (await tx.document.count({ where: { workspaceId } })) return false;
      await tx.workspace.deleteMany({ where: { id: workspaceId, deletedAt: { not: null } } });
      return true;
    });
  }

  private async cleanExternal(workspaceId: string, avatarKeys: string[]): Promise<void> {
    const warn = (what: string) => (e: Error) => this.logger.warn(`workspace ${workspaceId}: orphaned ${what}: ${e.message}`);
    // Every revision, attachment, import, export, embed snapshot and draft checkpoint lives under it.
    await this.storage.purgePrefix(`workspaces/${workspaceId}/`).catch(warn('objects'));
    for (const key of avatarKeys) await this.storage.purgeObjectVersions(key).catch(warn(`avatar ${key}`));
    await this.graph.deleteWorkspaceGraph(workspaceId).catch(warn('graph vertices'));
    await this.fulltext.deleteWorkspace(workspaceId).catch(warn('fulltext rows'));
    // Its revision bytes and settings in the read cache (#472): gone with it, not at TTL.
    await this.cache.invalidateWorkspace(workspaceId);
  }
}

function delegateOf(tx: Prisma.TransactionClient, model: Prisma.ModelName): WorkspaceDelegate {
  return (tx as unknown as Record<string, WorkspaceDelegate>)[model.charAt(0).toLowerCase() + model.slice(1)];
}
