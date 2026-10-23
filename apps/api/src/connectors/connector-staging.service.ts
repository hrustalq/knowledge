import { FigmaFilesService } from '../embeds/figma-files.service.js';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Connector, type ConnectorLink, type ConnectorRun, type ConnectorRunItem } from '@prisma/client';
import {
  SUPERSEDING_CONFLICT_REASONS,
  apiSpecContentType,
  isWikiUnitKey,
  wikiDelivery,
  wikiEnabled,
  type ConnectorConflictReason,
  type ConnectorItemAction,
  type DocumentCategory,
} from '@knowledge/contracts';
import { DocumentsService } from '../documents/documents.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import type { ConnectorAdapter, ConnectorContext, ExternalDocument, ExternalRef } from './adapters/connector.types.js';
import { composeMarkdown, sha256, stagedObject } from './connector-markdown.js';
import { ConnectorAclService } from './connector-acl.service.js';
import type { StoredAcl } from './connector-acl.js';

/** The item's own metadata blob. Small on purpose — the markdown is in the bucket. */
export interface ItemDraft {
  warnings?: string[];
  orphan?: boolean;
  /** Set when a model wrote the staged copy, so a rewrite is never mistaken for what was sent. */
  aiOp?: 'cleanup' | 'merge';
  /** Set once a person edited it by hand. */
  edited?: boolean;
  /** An API spec file (#78): stored as written, created as a spec document, updated by merge request. */
  spec?: ExternalDocument['spec'];
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
    private readonly acl: ConnectorAclService,
    private readonly figma: FigmaFilesService,
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
    const ref: ExternalRef = {
      externalId: item.externalId,
      title: item.title,
      ...(item.externalUrl ? { url: item.externalUrl } : {}),
      ...(item.externalVersion ? { version: item.externalVersion } : {}),
    };
    // Read before either skip (#76): who may open a page can change upstream
    // while its content does not, and an unchanged page still mirrors that now.
    const acl = await this.acl.capture(row, adapter, ctx, ref);

    // Cheapest possible skip: the far side says nothing changed.
    if (link && item.externalVersion && link.externalVersion === item.externalVersion) {
      ctx.debug('item: unchanged (version)', { id: item.externalId, version: item.externalVersion });
      await this.acl.applyToPage(row, link, acl);
      await this.prisma.connectorRunItem.update({
        where: { id: item.id },
        data: { status: 'unchanged', action: 'unchanged', linkId: link.id, documentId: link.documentId },
      });
      return { action: 'unchanged', unchanged: true };
    }

    const doc = await adapter.fetch(ctx, ref);
    // A Figma frame the source embeds is pinned to its file's current version on pull (#470).
    doc.markdown = await this.figma.pinMarkdown(row.workspaceId, doc.markdown);
    const markdown = composeMarkdown(doc);
    const hash = sha256(markdown);

    // The far side changed but produced identical content — a Confluence version
    // bump from a label edit, say. Record the version and move on.
    if (link && link.contentHash === hash) {
      ctx.debug('item: unchanged (hash)', { id: item.externalId });
      await this.acl.applyToPage(row, link, acl);
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
    const staged = stagedObject(doc.spec, 'staged');
    const incoming = stagedObject(doc.spec, 'incoming');
    const stagedKey = this.storage.connectorItemObjectKey(row.workspaceId, run.id, item.id, staged.name);
    const incomingKey = this.storage.connectorItemObjectKey(row.workspaceId, run.id, item.id, incoming.name);
    await this.storage.putObjectText(stagedKey, markdown, staged.contentType);
    await this.storage.putObjectText(incomingKey, markdown, incoming.contentType);

    // What mirroring will do to this page is said before anyone approves it.
    const warnings = [...doc.warnings, ...(acl ? await this.acl.preview(row, acl) : [])];
    const { spec: _previous, ...prior } = (item.draft as ItemDraft | null) ?? {};
    const draft: ItemDraft = {
      ...prior,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(doc.spec ? { spec: doc.spec } : {}),
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
        acl: acl ? (acl as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
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
    let localChanged = localHash !== null && link.contentHash !== null && localHash !== link.contentHash;
    // A merged repo wiki merge request (docs/features/46), or a merged spec
    // change (#78), moved the head to what this connector sent. That is not a
    // local edit: it is the connector's own page, arrived by review instead of
    // by a direct write.
    if (localChanged && localHash && (await this.isOurRegeneration(link.documentId, localHash))) localChanged = false;

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
    if (!item.stagedKey) throw new Error(t('error.connector.nothingStaged'));

    const markdown = await this.storage.getObjectText(item.stagedKey);
    const hash = sha256(markdown);
    const link = item.linkId ? await this.prisma.connectorLink.findUnique({ where: { id: item.linkId } }) : null;
    const spec = specOf(item);

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
      await this.acl.applyToPage(row, link, storedAcl(item));
      return;
    }

    // A spec (#78) is never written straight to its page, in any mode: the
    // breaking-change merge gate is enforced at merge, so a sync that wrote the
    // page directly would be a way round it. Approving the item in a reviewed
    // run approves opening the merge request, not merging it.
    if (spec && (item.action === 'update' || item.action === 'conflict')) {
      await this.openConflictBranch(row, run, link, item, markdown, item.action === 'conflict' ? 'conflict' : 'spec-changed');
      await this.acl.applyToPage(row, link, storedAcl(item));
      return;
    }

    // An unreviewed conflict is not resolved by overwriting: it goes to its own
    // branch and becomes a merge request, which is feature 19's whole answer to
    // two-way sync. A *reviewed* conflict has already been decided by a person,
    // so their approval writes straight to the page.
    if (item.action === 'conflict' && run.mode === 'auto') {
      await this.openConflictBranch(row, run, link, item, markdown, 'conflict');
      // Who may read the page is not part of the conflict: it mirrors now.
      await this.acl.applyToPage(row, link, storedAcl(item));
      return;
    }

    // A repo wiki delivered by merge request (docs/features/46): a regenerated
    // page goes to a branch and a merge request instead of to the page, so a
    // person reads what the code now says before readers do. Only in `auto` —
    // a review or step run has already put a person in front of it.
    if (item.action === 'update' && run.mode === 'auto' && deliversByMergeRequest(row, item.externalId)) {
      await this.openConflictBranch(row, run, link, item, markdown, 'regenerated');
      await this.acl.applyToPage(row, link, storedAcl(item));
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
    await this.acl.applyToPage(row, link, storedAcl(item));
  }

  private async createPage(
    row: Connector,
    run: ConnectorRun,
    item: ConnectorRunItem,
    markdown: string,
    hash: string,
  ): Promise<void> {
    const parentId = await this.resolveParent(row, item);
    const reRooted = row.preserveHierarchy && item.parentItemId !== null && parentId === row.parentId;

    // The page and the `connector_links` row that identifies it commit together.
    // They did not, and the gap was this feature's worst failure: a finalized,
    // indexed page with no link row is invisible to `decideAction`, which sees
    // `link === null`, decides 'create', and imports the same external item
    // again — on that pull and on EVERY pull after it, silently, forever. The
    // run-item update is inside for the same reason one step down: without it
    // the item keeps `linkId: null` and re-applying makes a second page plus a
    // second link for one `externalId`.
    //
    // The S3 write sits inside the boundary because the revision has to be
    // finalized against bytes that exist. It is a local MinIO PUT of one
    // markdown document, but it is still a network call holding a transaction
    // open, hence the raised timeout — the `ProjectCascadeService` precedent.
    await this.prisma.withTransaction(() => this.writePage(row, item, markdown, hash, parentId, reRooted), {
      timeout: 30_000,
      maxWait: 10_000,
    });
  }

  private async writePage(
    row: Connector,
    item: ConnectorRunItem,
    markdown: string,
    hash: string,
    parentId: string | null,
    reRooted: boolean,
  ): Promise<void> {
    const spec = specOf(item);
    // Created without inline content and written once afterwards, the way import
    // submit does: one revision, whose content was never half-written. A spec
    // (#78) goes in inline instead, because that is the path that names its
    // syntax — the revision is `source.json` or `source.yaml` from the start —
    // and validates it before the page exists. Its category is `reference`,
    // whatever the connector files its pages under: that is what a spec is.
    const created = spec
      ? await this.documents.createDocument({
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          title: item.title || 'API',
          category: 'reference',
          kind: spec.kind,
          content: { mode: 'inline', format: spec.syntax, text: markdown },
          ...(parentId ? { parentId } : {}),
        })
      : await this.documents.createDocument({
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          title: item.title || 'Untitled',
          category: row.category as DocumentCategory,
          ...(parentId ? { parentId } : {}),
        });

    if (!spec) {
      const revision = await this.prisma.documentRevision.findUnique({ where: { id: created.revisionId } });
      if (!revision) throw new Error('revision vanished between create and write');
      await this.storage.putObjectText(revision.s3Key, markdown, 'text/markdown');
      await this.documents.finalizeRevision(created.documentId, created.revisionId);
    }

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
    // In the same transaction as the page (#76): a page private upstream is
    // never, for any length of time, a page the whole workspace can open.
    await this.acl.applyToPage(row, link, storedAcl(item));

    // The page above this one has not been imported, so it was filed at the
    // connector's destination instead. That is the defined behaviour — a parent
    // nobody approved must not strand its children — but a page that quietly
    // lands somewhere other than where the external tree puts it is exactly the
    // silent move this feature exists to prevent, so it is said out loud.
    const draft: ItemDraft = (item.draft as ItemDraft | null) ?? {};
    const warnings = reRooted
      ? [...(draft.warnings ?? []), t('connector.warning.reRooted')]
      : draft.warnings;

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
        ...(warnings ? { draft: { ...draft, warnings } as unknown as Prisma.InputJsonValue } : {}),
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

    let top: ConnectorRunItem = item;
    // Bounded by the tree's own depth; the guard is against a cycle the far side
    // let somebody build, not against deep nesting.
    for (let hops = 0; top.parentItemId && hops < 64; hops += 1) {
      const parent: ConnectorRunItem | null = await this.prisma.connectorRunItem.findUnique({
        where: { id: top.parentItemId },
      });
      if (!parent) break;
      if (parent.documentId) return parent.documentId;
      top = parent;
    }

    // The top of this run's chain hangs under an item an earlier run imported:
    // an incremental pull (#338) carries only what changed, so a file added to
    // a folder imported last week arrives without that folder. Its link still
    // says where the folder's page is.
    if (top.externalParentId) {
      const link = await this.prisma.connectorLink.findUnique({
        where: { connectorId_externalId: { connectorId: row.id, externalId: top.externalParentId } },
        select: { documentId: true },
      });
      if (link && (await this.prisma.document.findUnique({ where: { id: link.documentId }, select: { id: true } }))) {
        return link.documentId;
      }
    }
    return row.parentId;
  }

  // --- shared writes ---

  /** A new revision on the document's default branch, through the normal pipeline. */
  private async writeRevision(
    documentId: string,
    markdown: string,
    branch?: string,
    spec?: ItemDraft['spec'],
  ): Promise<string> {
    const contentType = spec ? apiSpecContentType(spec.kind, spec.syntax) : 'text/markdown';
    const revision = await this.documents.createRevision(documentId, {
      branch,
      message: t('connector.syncRevisionMessage'),
      contentType,
    });
    const row = await this.prisma.documentRevision.findUnique({ where: { id: revision.revisionId } });
    if (!row) throw new Error('revision vanished between create and write');
    await this.storage.putObjectText(row.s3Key, markdown, row.contentType);
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
    run: ConnectorRun,
    link: ConnectorLink,
    item: ConnectorRunItem,
    markdown: string,
    reason: ConnectorConflictReason,
  ): Promise<void> {
    const branch =
      reason === 'regenerated'
        ? `wiki/${run.id.slice(0, 8)}-${Date.now().toString(36)}`
        : reason === 'spec-changed'
          ? `spec/${run.id.slice(0, 8)}-${Date.now().toString(36)}`
          : `connector/${row.kind}-${Date.now().toString(36)}`;
    await this.documents.createBranch(link.documentId, { name: branch });
    const revisionId = await this.writeRevision(link.documentId, markdown, branch, specOf(item));

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
        reason,
      },
    });
    await this.prisma.connectorRunItem.update({
      where: { id: item.id },
      data: { status: 'applied', documentId: link.documentId, revisionId, createdDocument: false },
    });
  }

  /**
   * Whether the head is byte-for-byte the last page this connector sent by
   * merge request — a regenerated wiki page, or a changed spec (#78).
   */
  private async isOurRegeneration(documentId: string, headHash: string): Promise<boolean> {
    const latest = await this.prisma.connectorConflict.findFirst({
      where: { documentId, reason: { in: [...SUPERSEDING_CONFLICT_REASONS] } },
      orderBy: { createdAt: 'desc' },
      select: { revisionId: true },
    });
    if (!latest) return false;
    return (await this.revisionHash(latest.revisionId)) === headHash;
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

  /**
   * sha256 of the branch head's stored bytes, or null when it cannot be read.
   *
   * The stored object, not the parsed body: `contentHash` is taken over the
   * markdown this connector wrote, frontmatter included, so the head must be
   * hashed the same way. Hashing `getContent().markdown` (the body without its
   * frontmatter) made every page that carries frontmatter — every codebase
   * page — look locally edited, and every update a conflict.
   */
  private async headContentHash(documentId: string): Promise<string | null> {
    const revisionId = await this.headRevisionId(documentId);
    return revisionId ? this.revisionHash(revisionId) : null;
  }

  private async revisionHash(revisionId: string): Promise<string | null> {
    const revision = await this.prisma.documentRevision.findUnique({
      where: { id: revisionId },
      select: { s3Key: true, status: true },
    });
    if (!revision || revision.status === 'draft') return null;
    try {
      return sha256(await this.storage.getObjectText(revision.s3Key));
    } catch {
      return null;
    }
  }
}

/**
 * The units a repo wiki delivers by merge request when the connector asks for
 * it (docs/features/46). Released changelog pages are not among them: a tag
 * never regenerates, so there is nothing to review twice.
 */
function deliversByMergeRequest(row: Connector, externalId: string): boolean {
  if (row.kind !== 'codebase') return false;
  const config = (row.config ?? {}) as Record<string, unknown>;
  if (!wikiEnabled(config) || wikiDelivery(config) !== 'merge-request') return false;
  return (
    externalId === 'overview' ||
    externalId.startsWith('module:') ||
    isWikiUnitKey(externalId) ||
    externalId === 'changelog:unreleased'
  );
}

/** The spec this item stages (#78), or undefined for a page. */
function specOf(item: ConnectorRunItem): ItemDraft['spec'] {
  return ((item.draft as ItemDraft | null) ?? {}).spec;
}

/** The ACL staging read for this item, if the connector mirrors (#76). */
function storedAcl(item: ConnectorRunItem): StoredAcl | null {
  return (item.acl as unknown as StoredAcl | null) ?? null;
}
