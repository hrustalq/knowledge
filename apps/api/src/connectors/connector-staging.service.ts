import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Connector, type ConnectorLink, type ConnectorRun, type ConnectorRunItem } from '@prisma/client';
import type { ConnectorItemAction, DocumentCategory } from '@knowledge/contracts';
import { DocumentsService } from '../documents/documents.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import type { ConnectorAdapter, ConnectorContext, ExternalRef } from './adapters/connector.types.js';
import { composeMarkdown, sha256 } from './connector-markdown.js';

/** The item's own metadata blob. Small on purpose — the markdown is in the bucket. */
export interface ItemDraft {
  warnings?: string[];
  orphan?: boolean;
  /** Set when a model wrote the staged copy, so a rewrite is never mistaken for what was sent. */
  aiOp?: 'cleanup' | 'merge';
  /** Set once a person edited it by hand. */
  edited?: boolean;
}

export interface StageOutcome {
  action: ConnectorItemAction;
  /** True when the two sides already agreed and nothing was staged. */
  unchanged: boolean;
}

/**
 * The life of one item: fetch it, work out what applying it would do, and — once
 * somebody (or `auto` mode) says so — write it (docs/features/26).
 *
 * Staging and applying are deliberately separate calls even in `auto` mode,
 * where they happen back to back. Keeping one code path for both means a
 * reviewed import and an unattended one produce identical results, rather than
 * the review path being a second, less-tested implementation of the same thing.
 */
@Injectable()
export class ConnectorStagingService {
  private readonly logger = new Logger(ConnectorStagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageService,
  ) {}

  // --- stage ---

  /**
   * Fetch the item and decide what it would do, without doing it.
   *
   * The two cheap skips come first and in this order: the far side's own version
   * marker, then a content hash. Both existed before this feature and both are
   * what make a re-sync nearly free; the difference now is that "unchanged" is a
   * row somebody can see rather than a counter.
   */
  async stage(
    row: Connector,
    run: ConnectorRun,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    item: ConnectorRunItem,
    link: ConnectorLink | null,
  ): Promise<StageOutcome> {
    // Cheapest possible skip: the far side says nothing changed.
    if (link && item.externalVersion && link.externalVersion === item.externalVersion) {
      ctx.debug('item: unchanged (version)', { id: item.externalId, version: item.externalVersion });
      await this.prisma.connectorRunItem.update({
        where: { id: item.id },
        data: { status: 'unchanged', action: 'unchanged', linkId: link.id, documentId: link.documentId },
      });
      return { action: 'unchanged', unchanged: true };
    }

    const ref: ExternalRef = {
      externalId: item.externalId,
      title: item.title,
      ...(item.externalUrl ? { url: item.externalUrl } : {}),
      ...(item.externalVersion ? { version: item.externalVersion } : {}),
    };

    const doc = await adapter.fetch(ctx, ref);
    const markdown = composeMarkdown(doc);
    const hash = sha256(markdown);

    // The far side changed but produced identical content — a Confluence version
    // bump from a label edit, say. Record the version and move on.
    if (link && link.contentHash === hash) {
      ctx.debug('item: unchanged (hash)', { id: item.externalId });
      await this.prisma.connectorLink.update({
        where: { id: link.id },
        data: { externalVersion: doc.ref.version ?? null, lastPulledAt: new Date() },
      });
      await this.prisma.connectorRunItem.update({
        where: { id: item.id },
        data: {
          status: 'unchanged',
          action: 'unchanged',
          contentHash: hash,
          externalVersion: doc.ref.version ?? null,
          linkId: link.id,
          documentId: link.documentId,
        },
      });
      return { action: 'unchanged', unchanged: true };
    }

    const action = await this.decideAction(row, link);

    // Both copies are written now: `staged.md` is what will be applied and may be
    // edited or rewritten by a model; `incoming.md` never changes, so "what did
    // the far side actually send" survives every later edit.
    const stagedKey = this.storage.connectorItemObjectKey(row.workspaceId, run.id, item.id, 'staged.md');
    const incomingKey = this.storage.connectorItemObjectKey(row.workspaceId, run.id, item.id, 'incoming.md');
    await this.storage.putObjectText(stagedKey, markdown, 'text/markdown');
    await this.storage.putObjectText(incomingKey, markdown, 'text/markdown');

    const draft: ItemDraft = {
      ...((item.draft as ItemDraft | null) ?? {}),
      ...(doc.warnings.length > 0 ? { warnings: doc.warnings } : {}),
    };

    ctx.debug('item: staged', { id: item.externalId, action, hash: hash.slice(0, 12) });
    await this.prisma.connectorRunItem.update({
      where: { id: item.id },
      data: {
        status: 'staged',
        action,
        title: doc.title || item.title,
        contentHash: hash,
        externalVersion: doc.ref.version ?? item.externalVersion,
        externalUrl: doc.ref.url ?? item.externalUrl,
        stagedKey,
        incomingKey,
        linkId: link?.id ?? null,
        documentId: link?.documentId ?? null,
        draft: draft as unknown as Prisma.InputJsonValue,
        error: null,
      },
    });

    return { action, unchanged: false };
  }

  /**
   * What applying would do. `conflict` means both sides moved since they last
   * agreed — the only case where writing would destroy something.
   */
  private async decideAction(row: Connector, link: ConnectorLink | null): Promise<ConnectorItemAction> {
    if (!link) return 'create';

    const document = await this.prisma.document.findUnique({ where: { id: link.documentId } });
    // The page was deleted here; the link is stale, so this is a fresh create.
    if (!document) return 'create';

    const localHash = await this.headContentHash(link.documentId);
    const localChanged = localHash !== null && link.contentHash !== null && localHash !== link.contentHash;

    if (!localChanged || row.conflict === 'external-wins') return 'update';
    if (row.conflict === 'local-wins') return 'unchanged';
    return 'conflict';
  }

  // --- apply ---

  /**
   * Write the staged item to the knowledge base.
   *
   * Runs in the worker. Feature 19 split `DocumentsCoreModule` out precisely so a
   * bulk pull could write pages from here; the feature-17 API-side sweeper is for
   * the rare, exceptional path and would trickle a 500-page import through a
   * five-second tick.
   */
  async apply(row: Connector, run: ConnectorRun, item: ConnectorRunItem): Promise<void> {
    if (item.documentId && item.status === 'applied') return; // idempotent
    if (!item.stagedKey) throw new Error('this item has nothing staged to apply');

    const markdown = await this.storage.getObjectText(item.stagedKey);
    const hash = sha256(markdown);
    const link = item.linkId ? await this.prisma.connectorLink.findUnique({ where: { id: item.linkId } }) : null;

    if (!link) {
      await this.createPage(row, run, item, markdown, hash);
      return;
    }

    const document = await this.prisma.document.findUnique({ where: { id: link.documentId } });
    if (!document) {
      // The page went away between staging and applying. The link is stale;
      // drop it and create afresh rather than failing the item.
      await this.prisma.connectorLink.delete({ where: { id: link.id } }).catch(() => undefined);
      await this.prisma.connectorRunItem.update({ where: { id: item.id }, data: { linkId: null } });
      await this.createPage(row, run, { ...item, linkId: null }, markdown, hash);
      return;
    }

    // `local-wins` never writes; it only records that this external version has
    // been seen, so the same decision is not re-made on every future run.
    if (item.action === 'unchanged') {
      await this.prisma.connectorLink.update({
        where: { id: link.id },
        data: { externalVersion: item.externalVersion, lastPulledAt: new Date() },
      });
      await this.prisma.connectorRunItem.update({
        where: { id: item.id },
        data: { status: 'unchanged', documentId: link.documentId },
      });
      return;
    }

    // An unreviewed conflict is not resolved by overwriting: it goes to its own
    // branch and becomes a merge request, which is feature 19's whole answer to
    // two-way sync. A *reviewed* conflict has already been decided by a person,
    // so their approval writes straight to the page.
    if (item.action === 'conflict' && run.mode === 'auto') {
      await this.openConflictBranch(row, link, item, markdown);
      return;
    }

    const previousRevisionId = await this.headRevisionId(link.documentId);
    const revisionId = await this.writeRevision(link.documentId, markdown);

    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: {
        contentHash: hash,
        revisionId,
        externalVersion: item.externalVersion,
        externalTitle: item.title,
        externalUrl: item.externalUrl ?? link.externalUrl,
        lastPulledAt: new Date(),
      },
    });
    await this.prisma.connectorRunItem.update({
      where: { id: item.id },
      data: {
        status: 'applied',
        documentId: link.documentId,
        revisionId,
        previousRevisionId,
        createdDocument: false,
        error: null,
      },
    });
  }

  private async createPage(
    row: Connector,
    run: ConnectorRun,
    item: ConnectorRunItem,
    markdown: string,
    hash: string,
  ): Promise<void> {
    const parentId = await this.resolveParent(row, item);

    // Created without inline content and written once afterwards, the way import
    // submit does: one revision, whose content was never half-written.
    const created = await this.documents.createDocument({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      title: item.title || 'Untitled',
      category: row.category as DocumentCategory,
      ...(parentId ? { parentId } : {}),
    });

    const revision = await this.prisma.documentRevision.findUnique({ where: { id: created.revisionId } });
    if (!revision) throw new Error('revision vanished between create and write');
    await this.storage.putObjectText(revision.s3Key, markdown, 'text/markdown');
    await this.documents.finalizeRevision(created.documentId, created.revisionId);

    const link = await this.prisma.connectorLink.create({
      data: {
        connectorId: row.id,
        workspaceId: row.workspaceId,
        documentId: created.documentId,
        externalId: item.externalId,
        externalUrl: item.externalUrl,
        externalTitle: item.title,
        externalVersion: item.externalVersion,
        contentHash: hash,
        revisionId: created.revisionId,
        lastPulledAt: new Date(),
      },
    });

    await this.prisma.connectorRunItem.update({
      where: { id: item.id },
      data: {
        status: 'applied',
        documentId: created.documentId,
        linkId: link.id,
        revisionId: created.revisionId,
        previousRevisionId: null,
        createdDocument: true,
        error: null,
      },
    });
  }

  /**
   * Where this page hangs (docs/features/26).
   *
   * `WorkflowMaterializerService.parentDocumentOf`'s rule verbatim: the nearest
   * ancestor that actually produced a page, falling back to the connector's
   * configured destination. A skipped or rejected parent is **transparent, not a
   * wall** — its children re-root rather than being stranded, which is the only
   * behaviour that lets somebody decline one page without losing its subtree.
   */
  private async resolveParent(row: Connector, item: ConnectorRunItem): Promise<string | null> {
    if (!row.preserveHierarchy) return row.parentId;

    let parentItemId = item.parentItemId;
    // Bounded by the tree's own depth; the guard is against a cycle the far side
    // let somebody build, not against deep nesting.
    for (let hops = 0; parentItemId && hops < 64; hops += 1) {
      const parent: ConnectorRunItem | null = await this.prisma.connectorRunItem.findUnique({
        where: { id: parentItemId },
      });
      if (!parent) break;
      if (parent.documentId) return parent.documentId;
      parentItemId = parent.parentItemId;
    }
    return row.parentId;
  }

  // --- shared writes ---

  /** A new revision on the document's default branch, through the normal pipeline. */
  private async writeRevision(documentId: string, markdown: string, branch?: string): Promise<string> {
    const revision = await this.documents.createRevision(documentId, {
      branch,
      message: t('connector.syncRevisionMessage'),
      contentType: 'text/markdown',
    });
    const row = await this.prisma.documentRevision.findUnique({ where: { id: revision.revisionId } });
    if (!row) throw new Error('revision vanished between create and write');
    await this.storage.putObjectText(row.s3Key, markdown, 'text/markdown');
    await this.documents.finalizeRevision(documentId, revision.revisionId);
    return revision.revisionId;
  }

  /**
   * Both sides changed and nobody has looked. Nothing is overwritten: the
   * external version goes onto its own branch and a conflict is recorded for the
   * API-side sweeper to open a merge request from, so Phase 3's structural and
   * semantic diffs do the work.
   */
  private async openConflictBranch(
    row: Connector,
    link: ConnectorLink,
    item: ConnectorRunItem,
    markdown: string,
  ): Promise<void> {
    const branch = `connector/${row.kind}-${Date.now().toString(36)}`;
    await this.documents.createBranch(link.documentId, { name: branch });
    const revisionId = await this.writeRevision(link.documentId, markdown, branch);

    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: {
        // The external version is recorded so the same conflict is not raised on
        // every run, but `contentHash` deliberately is not: the two sides have
        // not agreed on anything.
        externalVersion: item.externalVersion,
        externalTitle: item.title,
        lastPulledAt: new Date(),
      },
    });
    await this.prisma.connectorConflict.create({
      data: {
        connectorId: row.id,
        workspaceId: row.workspaceId,
        documentId: link.documentId,
        linkId: link.id,
        branch,
        revisionId,
        externalUrl: item.externalUrl,
        title: item.title,
      },
    });
    await this.prisma.connectorRunItem.update({
      where: { id: item.id },
      data: { status: 'applied', documentId: link.documentId, revisionId, createdDocument: false },
    });
  }

  /** The default branch head's revision id — what revert needs to restore. */
  private async headRevisionId(documentId: string): Promise<string | null> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { defaultBranch: true },
    });
    if (!document) return null;
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: document.defaultBranch } },
      select: { headRevisionId: true },
    });
    return branch?.headRevisionId ?? null;
  }

  /** sha256 of the branch head's markdown, or null when it cannot be read. */
  private async headContentHash(documentId: string): Promise<string | null> {
    try {
      const content = await this.documents.getContent(documentId);
      return sha256(content.markdown);
    } catch {
      return null;
    }
  }
}
