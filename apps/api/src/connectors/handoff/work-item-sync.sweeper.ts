import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector, ConnectorWorkItem } from '@prisma/client';
import { parseWorkItemRef, workItemStateFor, workItemStatusFor, type WorkItemStatus } from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { asLocale } from '../../i18n/locale.js';
import { t } from '../../i18n/t.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { TrackerAdapter, TrackerIssue } from '../adapters/tracker.js';
import { ConnectorWorkItemsService, keyOf } from '../connector-work-items.service.js';
import { TrackerRegistry } from '../tracker-registry.service.js';
import { labelFor } from './work-item-handoff.service.js';
import { WorkItemAnchorsService } from './work-item-anchors.service.js';
import { afterFailure, syncDecision } from './work-item-sync.js';

/** Outbound transitions per tick: a tracker's rate limit is shared with every other caller. */
const PUSH_BATCH = 10;
/** Anchored rows compared per tick. */
const RECONCILE_BATCH = 500;

/**
 * Keeps handed-off tickets and their anchors in step (#424).
 *
 * API-side, like DriftPublishSweeper: it writes to somebody else's tracker and
 * resolves reports in a person's name, and "the worker generates, the API
 * publishes". The worker-side `task.update` step stays the one documented
 * exception (feature 32). Three passes per tick, never two ticks at once:
 *
 * 1. **Poll** one tracker connector that has anchored tickets — the guaranteed
 *    inbound path. A webhook only gets the same row written sooner.
 * 2. **Reconcile** anchored rows: `syncDecision` picks the newer side. A closed
 *    ticket resolves its anchor; a resolved (or re-raised) anchor marks its row
 *    `pending`.
 * 3. **Push** due `pending` rows through the tracker, with backoff, into
 *    `failed` after the fifth attempt, or `orphaned` when the ticket is gone.
 */
@Injectable()
export class WorkItemSyncSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkItemSyncSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly tickMs: number;
  private readonly enabled: boolean;
  /** Round-robin position over the connectors to poll. Per process; a restart starts over. */
  private lastPolled = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackers: TrackerRegistry,
    private readonly workItems: ConnectorWorkItemsService,
    private readonly anchors: WorkItemAnchorsService,
    config: ConfigService<Env, true>,
  ) {
    this.tickMs = config.get('WORK_ITEM_SYNC_TICK_MS', { infer: true });
    this.enabled = config.get('WORK_ITEM_SYNC_ENABLED', { infer: true });
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Work item sync disabled (WORK_ITEM_SYNC_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), this.tickMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    // Back-pressure: never a second sweep while one is in flight.
    if (this.running) return;
    this.running = true;
    try {
      await this.step('poll', () => this.poll());
      await this.step('reconcile', () => this.reconcile());
      await this.step('push', () => this.push());
    } finally {
      this.running = false;
    }
  }

  // --- 1. poll ---

  /**
   * The next connector with anchored tickets, skipped while a content run is
   * in flight on it (one tracker conversation at a time per credential).
   */
  async poll(): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM connectors c
       WHERE c.enabled
         AND EXISTS (SELECT 1 FROM connector_work_items w WHERE w.connector_id = c.id AND w.source_kind IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM connector_runs r WHERE r.connector_id = c.id AND r.status IN ('queued', 'running'))
       ORDER BY c.id`;
    if (rows.length === 0) return;
    const next = rows.find((r) => r.id > this.lastPolled) ?? rows[0];
    this.lastPolled = next.id;
    const row = await this.prisma.connector.findUnique({ where: { id: next.id } });
    const tracker = row ? this.trackers.trackerFor(row) : null;
    if (!row || !tracker) return;
    await this.pollOne(row, tracker);
  }

  async pollOne(row: Connector, tracker: TrackerAdapter): Promise<number> {
    // Never polled: start from the oldest anchored ticket, not the repository's first issue.
    let since = row.taskCursor;
    if (!since) {
      const oldest = await this.prisma.connectorWorkItem.findFirst({
        where: { connectorId: row.id, sourceKind: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      since = oldest?.createdAt.toISOString() ?? new Date().toISOString();
    }
    const { items, cursor } = await tracker.listIssues(row, since);
    for (const item of items) {
      const saved = await this.workItems.applyPolled(row, item);
      if (!saved.sourceKind) await this.adopt(row, saved, item);
    }
    if (cursor && cursor !== row.taskCursor) {
      await this.prisma.connector.update({ where: { id: row.id }, data: { taskCursor: cursor } });
    }
    return items.length;
  }

  /**
   * A labelled ticket we have no anchor for — created before the row was
   * written, or the row was lost — is re-anchored from its `knowledge-ref:`
   * footer, when that object exists in this workspace and has no ticket yet.
   */
  private async adopt(row: Connector, saved: ConnectorWorkItem, item: TrackerIssue): Promise<void> {
    const ref = parseWorkItemRef(item.body);
    if (!ref || !item.labels.includes(labelFor(row))) return;
    const view = await this.anchors.describe(row.workspaceId, ref.kind, ref.id);
    if (!view) return;
    await this.prisma.connectorWorkItem
      .update({ where: { id: saved.id }, data: { sourceKind: view.kind, sourceId: view.id, documentId: saved.documentId ?? view.documentId } })
      .catch(() => undefined); // already anchored elsewhere: the unique index keeps the first
  }

  // --- 2. reconcile ---

  async reconcile(): Promise<void> {
    // ponytail: the 500 least recently written anchored rows each tick, so past
    // 500 synced rows the rest wait until those move; add an updated-since
    // watermark when a workspace holds that many open handoffs.
    const rows = await this.prisma.connectorWorkItem.findMany({
      where: { sourceKind: { in: ['issue', 'conflict', 'verification'] }, syncState: 'synced' },
      orderBy: { updatedAt: 'asc' },
      take: RECONCILE_BATCH,
    });
    if (rows.length === 0) return;
    const states = await this.anchors.states(rows);
    const connectors = await this.connectorsFor(rows);
    for (const item of rows) {
      const connector = connectors.get(item.connectorId);
      const anchor = states.get(item.id);
      if (!connector || !anchor) continue;
      if (anchor === 'missing') {
        await this.closeForDeletedAnchor(connector, item);
        continue;
      }
      const status = workItemStatusFor(item, this.workItems.mapFor(connector));
      const decision = syncDecision({ status, at: item.externalUpdatedAt }, anchor);
      if (!decision) continue;
      if (decision.direction === 'inbound') {
        const actor = await this.workItems.actorFor(connector, item.externalActorId);
        await this.anchors.resolve(connector, item, decision.status, actor);
      } else {
        await this.prisma.connectorWorkItem.updateMany({
          where: { id: item.id, syncState: 'synced' },
          data: { syncState: 'pending', pendingStatus: decision.status, syncAttempts: 0, nextSyncAt: null, syncError: null },
        });
      }
    }
  }

  /** The object is gone: say so on the ticket, close it, drop the row. A failure leaves it for the next tick. */
  private async closeForDeletedAnchor(connector: Connector, item: ConnectorWorkItem): Promise<void> {
    const tracker = this.trackers.trackerFor(connector);
    const raw = this.workItems.mapFor(connector).outbound.wont_do;
    if (!tracker) return;
    try {
      await tracker.comment(connector, item, [{ text: t('connector.workItem.deleted', {}, asLocale(connector.locale)) }]);
      if (raw) await tracker.transition(connector, item, raw);
      await this.prisma.connectorWorkItem.delete({ where: { id: item.id } });
    } catch (err) {
      this.logger.warn(`could not close ${keyOf(item)} for a deleted anchor: ${(err as Error).message}`);
    }
  }

  // --- 3. push ---

  async push(now = new Date()): Promise<void> {
    // ponytail: no claim column, so two API replicas could push one row twice;
    // a transition is idempotent and prod runs one replica. Claim with a lease if that changes.
    const due = await this.prisma.connectorWorkItem.findMany({
      where: { syncState: 'pending', OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }] },
      orderBy: { updatedAt: 'asc' },
      take: PUSH_BATCH,
    });
    const connectors = await this.connectorsFor(due);
    for (const item of due) {
      const connector = connectors.get(item.connectorId);
      if (connector) await this.pushOne(connector, item, now);
    }
  }

  private async pushOne(connector: Connector, item: ConnectorWorkItem, now: Date): Promise<void> {
    const tracker = this.trackers.trackerFor(connector);
    const status = item.pendingStatus as WorkItemStatus | null;
    const map = this.workItems.mapFor(connector);
    const raw = status ? map.outbound[status] : undefined;
    if (!tracker || !status || !raw) {
      // A transition the map cannot express is reported, not guessed.
      await this.fail(item, t('error.workItem.unmappedStatus', { status: status ?? '—' }, asLocale(connector.locale)));
      return;
    }
    const wasClosed = workItemStateFor(workItemStatusFor(item, map)) === 'closed';
    try {
      const moved = await tracker.transition(connector, item, raw);
      if (!moved) {
        await this.prisma.connectorWorkItem.update({
          where: { id: item.id },
          data: { syncState: 'orphaned', pendingStatus: null, syncError: t('error.workItem.ticketGone', {}, asLocale(connector.locale)) },
        });
        return;
      }
      if (status === 'open' && wasClosed) {
        await tracker
          .comment(connector, item, [{ text: t('connector.workItem.reraised', {}, asLocale(connector.locale)) }])
          .catch((err: Error) => this.logger.warn(`reopen comment on ${keyOf(item)} failed: ${err.message}`));
      }
      // The tracker's answer is the projection now — and its updated_at, being
      // newer than the anchor, is what keeps the next reconcile from pushing again.
      // Quiet: the act was the anchor's resolution, which has its own activity row.
      await this.workItems.upsertFrom(connector, moved, { actorId: null, quiet: true });
      await this.prisma.connectorWorkItem.update({
        where: { id: item.id },
        data: { syncState: 'synced', pendingStatus: null, syncAttempts: 0, nextSyncAt: null, syncError: null },
      });
    } catch (err) {
      await this.fail(item, (err as Error).message, now);
    }
  }

  private async fail(item: ConnectorWorkItem, message: string, now = new Date()): Promise<void> {
    await this.prisma.connectorWorkItem.update({
      where: { id: item.id },
      data: { ...afterFailure(item.syncAttempts, now, this.tickMs), syncError: message.slice(0, 500) },
    });
  }

  private async connectorsFor(rows: ConnectorWorkItem[]): Promise<Map<string, Connector>> {
    const ids = [...new Set(rows.map((r) => r.connectorId))];
    if (ids.length === 0) return new Map();
    const connectors = await this.prisma.connector.findMany({ where: { id: { in: ids }, enabled: true } });
    return new Map(connectors.map((c) => [c.id, c]));
  }

  private async step(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.logger.warn(`work item sync ${name} failed: ${(err as Error).message}`);
    }
  }
}
