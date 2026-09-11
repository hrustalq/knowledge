import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ConnectorRun, type ConnectorRunItem } from '@prisma/client';
import {
  allowedItemEvents,
  allowedRunEvents,
  type ConnectorItemAction,
  type ConnectorItemEventType,
  type ConnectorRunEventType,
  type ConnectorRunInfo,
  type ConnectorRunItemInfo,
  type ConnectorRunItemStatus,
  type ConnectorSyncMode,
} from '@knowledge/contracts';
import { DocumentsService } from '../documents/documents.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectCascadeService } from '../projects/project-cascade.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ConnectorProducer } from './connector.producer.js';
import type { RunWarning } from './connector-sync.service.js';
import type { ItemDraft } from './connector-staging.service.js';
import { sha256 } from './connector-markdown.js';
import { MAX_WARNINGS, toRunInfo } from './connectors.service.js';

/**
 * Everything a person does to a staged import (docs/features/26).
 *
 * API-side on purpose. Approving is somebody's act and is attributed to them;
 * reverting can delete a page, which is the one operation in this feature that
 * destroys something. Neither belongs in a worker that runs unattended.
 */
@Injectable()
export class ConnectorItemsService {
  private readonly logger = new Logger(ConnectorItemsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageService,
    private readonly producer: ConnectorProducer,
    // The product's only page-teardown path. Revert reuses it rather than
    // reimplementing the delete ordering.
    private readonly cascade: ProjectCascadeService,
    private readonly events: EventsPublisher,
  ) {}

  // --- reads ---

  async listItems(runId: string): Promise<{ items: ConnectorRunItemInfo[]; truncated: boolean }> {
    const run = await this.requireRun(runId);
    const rows = await this.prisma.connectorRunItem.findMany({
      where: { runId },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
    });
    const warned = readWarnings(run).some((w) => w.externalId === null && /max/i.test(w.message));
    return { items: rows.map(toItemInfo), truncated: warned };
  }

  /**
   * One item with its prepared text.
   *
   * `incoming` is returned only when it differs from what would be applied — an
   * unchanged copy beside an identical one is noise, and its presence is the
   * signal that something (a person or a model) altered the conversion.
   */
  async getItem(runId: string, itemId: string) {
    const item = await this.requireItem(runId, itemId);
    const markdown = item.stagedKey ? await this.readObject(item.stagedKey) : '';
    const incomingRaw = item.incomingKey ? await this.readObject(item.incomingKey) : null;
    const incoming = incomingRaw !== null && incomingRaw !== markdown ? incomingRaw : null;

    let localHead: string | null = null;
    // `unchanged` is included deliberately. It writes no staged copy at all —
    // the two sides already agree — so without the page itself the review pane
    // has nothing to show, and on a second sync almost every row is `unchanged`.
    if (item.documentId && (item.action === 'conflict' || item.action === 'update' || item.action === 'unchanged')) {
      localHead = await this.documents
        .getContent(item.documentId)
        .then((c) => c.markdown)
        .catch(() => null);
    }

    return { item: toItemInfo(item), markdown, incoming, localHead };
  }

  // --- edit ---

  async updateItem(
    runId: string,
    itemId: string,
    patch: { title?: string; markdown?: string },
  ): Promise<ConnectorRunItemInfo> {
    const item = await this.requireItem(runId, itemId);
    // Editing what has already been written would be a lie: the page is the
    // thing to edit at that point, and it has its own editor.
    if (item.status !== 'staged' && item.status !== 'failed') {
      throw new ConflictException(t('error.connector.itemNotEditable'));
    }

    const data: Prisma.ConnectorRunItemUpdateInput = {};
    if (patch.title !== undefined) data.title = patch.title.trim() || item.title;

    if (patch.markdown !== undefined) {
      const run = await this.requireRun(runId);
      const key =
        item.stagedKey ?? this.storage.connectorItemObjectKey(run.workspaceId, runId, item.id, 'staged.md');
      await this.storage.putObjectText(key, patch.markdown, 'text/markdown');
      data.stagedKey = key;
      data.contentHash = sha256(patch.markdown);
      const draft: ItemDraft = { ...((item.draft as ItemDraft | null) ?? {}), edited: true };
      data.draft = draft as unknown as Prisma.InputJsonValue;
    }

    const updated = await this.prisma.connectorRunItem.update({ where: { id: item.id }, data });
    return toItemInfo(updated);
  }

  // --- item events ---

  async sendItemEvent(
    runId: string,
    itemId: string,
    type: ConnectorItemEventType,
    subtree: boolean,
  ): Promise<{ items: ConnectorRunItemInfo[]; run: ConnectorRunInfo }> {
    const root = await this.requireItem(runId, itemId);
    const targets = subtree ? await this.subtreeOf(runId, root) : [root];

    // Filling is the one event the API does not perform: it needs the adapter,
    // and a branch can be hundreds of pages. The rows are left exactly as they
    // are and a scoped `fill` task claims them one at a time, so this works on a
    // paused run without disturbing the walk it was paused in.
    if (type === 'FETCH') {
      const fillable = targets.filter((i) => i.status === 'discovered');
      if (fillable.length === 0) {
        if (subtree) return { items: [], run: await this.runInfo(runId) };
        throw new ConflictException(t('error.connector.itemEvent', { status: root.status }));
      }
      await this.producer.enqueueTask(
        runId,
        { kind: 'fill', itemIds: fillable.map((i) => i.id) },
        String(Date.now()),
      );
      return { items: fillable.map(toItemInfo), run: await this.runInfo(runId) };
    }

    const touched: ConnectorRunItem[] = [];
    // Deepest first: a revert must remove children before their parent, and for
    // every other event the order is harmless.
    const ordered = type === 'REVERT' ? [...targets].sort((a, b) => b.depth - a.depth) : targets;

    for (const item of ordered) {
      // A subtree event applies to whatever in it can take the event, and quietly
      // passes over the rest — asking someone to approve a subtree and having it
      // refuse because one page inside it is already applied would be useless.
      if (!allowedItemEvents({ status: item.status as ConnectorRunItemStatus }).includes(type)) {
        if (subtree) continue;
        throw new ConflictException(t('error.connector.itemEvent', { status: item.status }));
      }
      touched.push(await this.applyItemEvent(item, type));
    }

    const run = await this.resume(runId, type);
    return { items: touched.map(toItemInfo), run };
  }

  private async applyItemEvent(item: ConnectorRunItem, type: ConnectorItemEventType): Promise<ConnectorRunItem> {
    switch (type) {
      case 'FETCH':
        // Handled before the loop: it enqueues rather than writing a row.
        return item;
      case 'APPROVE':
        // Marked only: the worker writes. One apply path for reviewed and
        // unattended runs alike, so the reviewed one is not a second
        // implementation that drifts.
        return this.prisma.connectorRunItem.update({ where: { id: item.id }, data: { status: 'approved' } });
      case 'SKIP':
        return this.prisma.connectorRunItem.update({ where: { id: item.id }, data: { status: 'skipped' } });
      case 'REJECT':
        return this.prisma.connectorRunItem.update({ where: { id: item.id }, data: { status: 'rejected' } });
      case 'RETRY':
        return this.prisma.connectorRunItem.update({
          where: { id: item.id },
          data: { status: 'discovered', error: null, attempt: { increment: 1 } },
        });
      case 'REVERT':
        return this.revertItem(item);
    }
  }

  /**
   * Undo one applied item.
   *
   * A created page is deleted outright. An updated one is **restored by writing
   * a new revision**, never by deleting the one the import added: the revision
   * DAG is immutable, and a history with a hole in it is worse than a history
   * that records the mistake and the correction.
   *
   * The link is rolled back too. Without that, the next sync would see the far
   * side unchanged, decide there was nothing to do, and leave the revert
   * standing — or worse, see a difference and redo exactly what was undone.
   */
  private async revertItem(item: ConnectorRunItem): Promise<ConnectorRunItem> {
    if (!item.documentId) throw new ConflictException(t('error.connector.itemNotApplied'));

    if (item.createdDocument) {
      // Refuse rather than orphan. A subtree revert deletes deepest-first, so
      // anything still under this page was put there by someone else — deleting
      // it silently, or stranding it at the root, are both worse than stopping.
      const children = await this.prisma.document.count({ where: { parentId: item.documentId } });
      if (children > 0) {
        throw new ConflictException(t('error.connector.revertHasChildren', { count: children }));
      }

      const document = await this.prisma.document.findUnique({ where: { id: item.documentId } });
      if (document) {
        await this.cascade.cascadeDocuments([item.documentId], document.workspaceId);
      }
    } else if (item.previousRevisionId) {
      const previous = await this.prisma.documentRevision.findUnique({ where: { id: item.previousRevisionId } });
      if (!previous) throw new ConflictException(t('error.connector.revertNoPrevious'));

      const markdown = await this.storage.getObjectText(previous.s3Key);
      const revision = await this.documents.createRevision(item.documentId, {
        message: t('connector.revertRevisionMessage'),
        contentType: 'text/markdown',
      });
      const row = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: revision.revisionId } });
      await this.storage.putObjectText(row.s3Key, markdown, 'text/markdown');
      await this.documents.finalizeRevision(item.documentId, revision.revisionId);

      if (item.linkId) {
        await this.prisma.connectorLink.update({
          where: { id: item.linkId },
          data: { contentHash: sha256(markdown), revisionId: revision.revisionId },
        });
      }
    } else {
      throw new ConflictException(t('error.connector.revertNoPrevious'));
    }

    const run = await this.prisma.connectorRun.update({
      where: { id: item.runId },
      data: { reverted: { increment: 1 } },
    });
    await this.events.publish({
      workspaceId: run.workspaceId,
      type: 'connector.item.reverted',
      subjectId: run.id,
      documentId: item.documentId,
      title: item.title,
    });

    return this.prisma.connectorRunItem.update({
      where: { id: item.id },
      data: { status: 'reverted', createdDocument: false },
    });
  }

  // --- run events ---

  async sendRunEvent(runId: string, type: ConnectorRunEventType): Promise<ConnectorRunInfo> {
    const run = await this.requireRun(runId);
    const awaiting = await this.awaitingCount(runId);
    const legal = allowedRunEvents({
      status: run.status as never,
      mode: run.mode as ConnectorSyncMode,
      awaitingReview: awaiting,
      phase: run.phase as never,
      discovered: run.discovered,
    });
    if (!legal.includes(type)) {
      throw new ConflictException(t('error.connector.runEvent', { status: run.status }));
    }

    switch (type) {
      case 'PAUSE': {
        // A guarded write, because the worker is writing to this row too. If it
        // has already moved on, the pause simply did not catch it — the next
        // event will.
        const paused = await this.prisma.connectorRun.updateMany({
          where: { id: runId, status: { in: ['queued', 'running'] } },
          data: { status: 'paused', stage: null },
        });
        if (paused.count === 1) {
          await this.publishRun(run, 'connector.run.paused');
        }
        break;
      }
      case 'RESUME':
        await this.prisma.connectorRun.update({ where: { id: runId }, data: { status: 'queued' } });
        await this.producer.enqueueRetry(runId, String(run.discovered + run.applied + 1));
        await this.publishRun(run, 'connector.run.resumed');
        break;
      case 'FILL': {
        // Stop walking and work with what the walk found. Moving the phase
        // pointer past `discovering` is what ends the walk: it is only ever read
        // forwards, so discovery never resumes. The frontier is deliberately
        // left in `cursor` — unused, but it is the record of what went unread,
        // and `finish()` clears it.
        const unwalked = Array.isArray(run.cursor) ? (run.cursor as unknown[]).length : 0;
        const warnings = readWarnings(run);
        if (unwalked > 0 && warnings.length < MAX_WARNINGS) {
          // A lossy import that says nothing is the failure this feature exists
          // to prevent, and stopping the walk is exactly that kind of loss.
          warnings.push({
            externalId: null,
            title: null,
            message: t('connector.warning.discoveryStopped', { count: unwalked }),
          });
        }
        await this.prisma.connectorRun.update({
          where: { id: runId },
          data: {
            status: 'queued',
            phase: 'fetching',
            warnings: warnings as unknown as Prisma.InputJsonValue,
          },
        });
        // Salted by clock rather than by the run's counters, which every other
        // event uses to collapse a double-click. Those counters do not move when
        // the phase does, so a FILL issued just after a RESUME would carry that
        // job's id, be dropped as a duplicate, and leave the run `queued` with
        // nothing coming for it.
        await this.producer.enqueueRetry(runId, `fill-${Date.now()}`);
        await this.publishRun(run, 'connector.run.resumed');
        break;
      }
      case 'NEXT':
        await this.prisma.connectorRun.update({
          where: { id: runId },
          data: { status: 'queued', phase: 'fetching' },
        });
        await this.producer.enqueueRetry(runId, String(run.discovered + run.applied + 1));
        break;
      case 'CANCEL':
        await this.prisma.connectorRun.update({
          where: { id: runId },
          data: { status: 'cancelled', phase: null, stage: null, completedAt: new Date() },
        });
        break;
      case 'APPROVE_ALL':
        await this.prisma.connectorRunItem.updateMany({
          where: { runId, status: 'staged' },
          data: { status: 'approved' },
        });
        await this.startApplying(runId, run);
        break;
    }

    return this.runInfo(runId);
  }

  /**
   * Write what is approved.
   *
   * A paused run gets a scoped `apply` task instead of the phase flip: it must
   * come out of this still paused, with its discovery frontier where it was.
   * Approval is a person's decision about one page, not an instruction to
   * restart the walk they stopped.
   */
  private async startApplying(runId: string, run: ConnectorRun): Promise<void> {
    if (run.status === 'paused') {
      await this.producer.enqueueTask(runId, { kind: 'apply' }, String(Date.now()));
      return;
    }
    await this.prisma.connectorRun.update({
      where: { id: runId },
      data: { status: 'queued', phase: 'applying' },
    });
    await this.producer.enqueueRetry(runId, String(run.discovered + run.applied + 1));
  }

  /**
   * An approval is what sets a parked run going again — and now a paused one
   * too, where `startApplying` writes without lifting the pause.
   */
  private async resume(runId: string, type: ConnectorItemEventType): Promise<ConnectorRunInfo> {
    if (type === 'APPROVE') {
      const run = await this.requireRun(runId);
      if (run.status === 'awaiting-review' || run.status === 'paused') await this.startApplying(runId, run);
    }
    return this.runInfo(runId);
  }

  // --- helpers ---

  async runInfo(runId: string): Promise<ConnectorRunInfo> {
    const run = await this.requireRun(runId);
    return toRunInfo(run, await this.awaitingCount(runId));
  }

  private awaitingCount(runId: string): Promise<number> {
    return this.prisma.connectorRunItem.count({ where: { runId, status: 'staged' } });
  }

  /** Every descendant of an item, the tree walked in Node over one query. */
  private async subtreeOf(runId: string, root: ConnectorRunItem): Promise<ConnectorRunItem[]> {
    const all = await this.prisma.connectorRunItem.findMany({ where: { runId } });
    const byParent = new Map<string | null, ConnectorRunItem[]>();
    for (const item of all) {
      const list = byParent.get(item.parentItemId) ?? [];
      list.push(item);
      byParent.set(item.parentItemId, list);
    }

    const out: ConnectorRunItem[] = [];
    const queue = [root];
    // `seen` guards against a parent cycle the far side allowed somebody to
    // build; without it this walk would not terminate.
    const seen = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift() as ConnectorRunItem;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      queue.push(...(byParent.get(item.id) ?? []));
    }
    return out;
  }

  private async publishRun(run: ConnectorRun, type: string): Promise<void> {
    const connector = await this.prisma.connector.findUnique({ where: { id: run.connectorId } });
    await this.events.publish({
      workspaceId: run.workspaceId,
      type,
      subjectId: run.id,
      ...(connector ? { title: connector.name } : {}),
    });
  }

  private async readObject(key: string): Promise<string> {
    return this.storage.getObjectText(key).catch(() => '');
  }

  async requireRun(runId: string): Promise<ConnectorRun> {
    const run = await this.prisma.connectorRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(t('error.connector.runNotFound'));
    return run;
  }

  async requireItem(runId: string, itemId: string): Promise<ConnectorRunItem> {
    const item = await this.prisma.connectorRunItem.findUnique({ where: { id: itemId } });
    // Checked against the run in the path, not just fetched by id: the ACL guard
    // authorised *this run*, so an item id from another one must not resolve.
    if (!item || item.runId !== runId) throw new NotFoundException(t('error.connector.itemNotFound'));
    return item;
  }
}

export function toItemInfo(row: ConnectorRunItem): ConnectorRunItemInfo {
  const draft = (row.draft as ItemDraft | null) ?? {};
  return {
    id: row.id,
    runId: row.runId,
    parentItemId: row.parentItemId,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    externalVersion: row.externalVersion,
    title: row.title,
    depth: row.depth,
    position: row.position,
    hasChildren: row.hasChildren,
    status: row.status as ConnectorRunItemStatus,
    action: (row.action as ConnectorItemAction | null) ?? null,
    warnings: draft.warnings ?? [],
    aiOp: draft.aiOp ?? null,
    edited: draft.edited ?? false,
    documentId: row.documentId,
    error: row.error,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function readWarnings(run: ConnectorRun): RunWarning[] {
  return Array.isArray(run.warnings) ? (run.warnings as unknown as RunWarning[]) : [];
}
