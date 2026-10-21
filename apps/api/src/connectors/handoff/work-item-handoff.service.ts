import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Connector, type ConnectorWorkItem } from '@prisma/client';
import type { ConnectorWorkItemInfo, WorkItemHandoffInput, WorkItemSourceKind } from '@knowledge/contracts';
import { ActivityService } from '../../activity/activity.service.js';
import type { Principal } from '../../auth/principal.js';
import { asLocale } from '../../i18n/locale.js';
import { t } from '../../i18n/t.js';
import { PermissionService } from '../../permissions/permission.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { TrackerAdapter } from '../adapters/tracker.js';
import { ConnectorWorkItemsService, keyOf } from '../connector-work-items.service.js';
import { ConnectorsService } from '../connectors.service.js';
import { WorkItemAnchorsService, type AnchorView } from './work-item-anchors.service.js';

/** The label a handed-off ticket carries unless the connector names another. */
const DEFAULT_LABEL = 'knowledge';

/**
 * Handoff (#424): give a knowledge object a ticket in a tracker, by creating
 * one or attaching one that exists. One service behind every caller — a
 * person's chip, a bulk action, a rule, the MCP tool — so the checks below are
 * the checks, whoever asks.
 *
 * Idempotent per (connector, anchor): a second handoff returns the ticket the
 * first one made. API-side, because it writes to somebody else's tracker in a
 * person's name.
 */
@Injectable()
export class WorkItemHandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly workItems: ConnectorWorkItemsService,
    private readonly anchors: WorkItemAnchorsService,
    private readonly permissions: PermissionService,
    private readonly activity: ActivityService,
  ) {}

  /** Create-or-attach. The caller must be able to edit the anchor's page. */
  async handoff(principal: Principal, input: WorkItemHandoffInput): Promise<ConnectorWorkItemInfo> {
    const view = await this.requireAnchor(principal, input.workspaceId, input.sourceKind, input.sourceId);
    const route = await this.prisma.projectTrackerRoute.findUnique({ where: { projectId: view.projectId } });
    const connectorId = input.connectorId ?? route?.connectorId;
    if (!connectorId) throw new BadRequestException(t('error.workItem.noRoute'));
    const { row, tracker } = await this.requireTracker(input.workspaceId, connectorId);

    const existing = await this.prisma.connectorWorkItem.findFirst({
      where: { connectorId: row.id, sourceKind: view.kind, sourceId: view.id },
    });
    if (existing) {
      if (input.attach && !sameTicket(tracker, row, existing, input.attach)) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.workItem.anchorTaken', { key: keyOf(existing), name: row.name }),
          reason: 'anchor-taken',
          workItemId: existing.id,
        });
      }
      return (await this.workItems.decorate([existing]))[0];
    }

    const anchor = { kind: view.kind, id: view.id };
    let saved: ConnectorWorkItem;
    if (input.attach) {
      const ref = tracker.parseRef(row, input.attach);
      if (!ref) throw new BadRequestException(t('error.workItem.badRef', { ref: input.attach, name: row.name }));
      const issue = await tracker.getIssue(row, ref);
      if (!issue) throw new NotFoundException(t('error.workItem.ticketNotFound', { ref: input.attach, name: row.name }));
      const held = await this.prisma.connectorWorkItem.findUnique({
        where: { connectorId_kind_number: { connectorId: row.id, kind: issue.kind, number: issue.number } },
      });
      if (held?.sourceId && (held.sourceKind !== view.kind || held.sourceId !== view.id)) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.workItem.ticketTaken', { key: keyOf(held) }),
          reason: 'ticket-taken',
          workItemId: held.id,
        });
      }
      saved = await this.workItems.upsertFrom(row, issue, { documentId: view.documentId, anchor });
    } else {
      const text = await this.anchors.ticketText(view, asLocale(row.locale));
      const issue = await tracker.createIssue(row, {
        ...text,
        labels: [labelFor(row)],
        externalProject: route?.connectorId === row.id ? route.externalProject : null,
        issueType: route?.connectorId === row.id ? route.issueType : null,
      });
      saved = await this.save(row, () => this.workItems.upsertFrom(row, issue, { documentId: view.documentId, anchor }));
    }

    void this.activity.record({
      workspaceId: row.workspaceId,
      actor: principal.userId,
      action: 'connector.work-item.handoff',
      documentId: view.documentId,
      subjectId: saved.id,
      metadata: { key: keyOf(saved), url: saved.url, sourceKind: view.kind, sourceId: view.id, attached: !!input.attach, connectorId: row.id },
    });
    return (await this.workItems.decorate([saved]))[0];
  }

  /**
   * Attach an existing row to a page (feature 32) or, since #424, to an anchor.
   * Either way the caller must be able to edit the page it lands on.
   */
  async link(
    principal: Principal,
    row: Connector,
    workItemId: string,
    to: { documentId?: string; sourceKind?: WorkItemSourceKind; sourceId?: string },
  ): Promise<ConnectorWorkItemInfo> {
    const item = await this.workItems.require(row, workItemId);
    if (to.documentId && to.sourceKind) throw new BadRequestException(t('error.workItem.anchorOrDocument'));
    const kind = to.sourceKind ?? 'document';
    const id = to.sourceId ?? to.documentId;
    if (!id) throw new BadRequestException(t('error.workItem.anchorOrDocument'));
    const view = await this.requireAnchor(principal, row.workspaceId, kind, id);
    // A bare page link keeps feature 32's meaning — several issues may name one
    // page — so it sets no anchor. An explicit anchor is one ticket per object.
    const data = to.sourceKind
      ? { documentId: view.documentId, sourceKind: view.kind, sourceId: view.id }
      : { documentId: view.documentId };
    const updated = await this.save(row, () => this.prisma.connectorWorkItem.update({ where: { id: item.id }, data }));
    return (await this.workItems.decorate([updated]))[0];
  }

  /** Stop relating the two. The ticket stays open on the tracker. */
  async unlink(principal: Principal, row: Connector, workItemId: string): Promise<ConnectorWorkItemInfo> {
    const before = await this.workItems.require(row, workItemId);
    const after = await this.workItems.unlink(row, workItemId);
    if (before.sourceKind || before.documentId) {
      void this.activity.record({
        workspaceId: row.workspaceId,
        actor: principal.userId,
        action: 'connector.work-item.unlinked',
        ...(before.documentId ? { documentId: before.documentId } : {}),
        subjectId: before.id,
        metadata: { key: keyOf(before), url: before.url, sourceKind: before.sourceKind, sourceId: before.sourceId },
      });
    }
    return after;
  }

  /** A person's retry after the sweeper gave up: back to pending, attempts from zero. */
  async retry(row: Connector, workItemId: string): Promise<ConnectorWorkItemInfo> {
    const item = await this.workItems.require(row, workItemId);
    const { count } = await this.prisma.connectorWorkItem.updateMany({
      where: { id: item.id, syncState: { in: ['failed', 'orphaned'] } },
      // An orphan has nothing pending; the next reconcile decides afresh.
      data: item.pendingStatus
        ? { syncState: 'pending', syncAttempts: 0, nextSyncAt: null, syncError: null }
        : { syncState: 'synced', syncAttempts: 0, nextSyncAt: null, syncError: null },
    });
    if (!count) {
      throw new ConflictException({ statusCode: 409, message: t('error.workItem.notRetryable'), reason: 'not-retryable', syncState: item.syncState });
    }
    return (await this.workItems.decorate([await this.workItems.require(row, workItemId)]))[0];
  }

  /** The tickets on one anchor, as this caller may see them. */
  async forAnchor(principal: Principal, workspaceId: string, kind: WorkItemSourceKind, id: string): Promise<ConnectorWorkItemInfo[]> {
    return this.workItems.listForAnchor(await this.permissions.scopeFor(principal, workspaceId), kind, id);
  }

  // --- internals ---

  /**
   * The anchor, refused the way a page is refused: a page the caller cannot
   * open is the guard's 403/404 (never its title), and a conflict whose other
   * page they cannot open is a plain 404.
   */
  private async requireAnchor(principal: Principal, workspaceId: string, kind: WorkItemSourceKind, id: string): Promise<AnchorView> {
    const view = await this.anchors.describe(workspaceId, kind, id);
    const notFound = () => new NotFoundException(t('error.workItem.anchorNotFound', { kind, id }));
    if (!view) throw notFound();
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    await this.permissions.requireLevel(scope, { type: 'document', id: view.documentId }, 'edit');
    if (view.otherDocumentId && !(await this.permissions.visibleDocumentIds(scope, [view.otherDocumentId])).size) throw notFound();
    return view;
  }

  private async requireTracker(workspaceId: string, connectorId: string): Promise<{ row: Connector; tracker: TrackerAdapter }> {
    const row = await this.connectors.require(connectorId).catch(() => null);
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException(t('error.connector.notFound', { id: connectorId }));
    if (!row.enabled) throw new BadRequestException(t('error.workItem.connectorDisabled', { name: row.name }));
    return { row, tracker: this.workItems.requireTracker(row) };
  }

  /** A write that would give one anchor two tickets on one connector is a 409, not a 500. */
  private async save<T>(row: Connector, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ statusCode: 409, message: t('error.workItem.anchorTaken', { key: '', name: row.name }), reason: 'anchor-taken' });
      }
      throw err;
    }
  }
}

/** The label a connector puts on handed-off tickets: `config.workItemLabel`, else `knowledge`. */
export function labelFor(row: Pick<Connector, 'config'>): string {
  const label = (row.config as { workItemLabel?: unknown } | null)?.workItemLabel;
  return typeof label === 'string' && label.trim() ? label.trim().slice(0, 50) : DEFAULT_LABEL;
}

function sameTicket(tracker: TrackerAdapter, row: Connector, item: ConnectorWorkItem, attach: string): boolean {
  const ref = tracker.parseRef(row, attach);
  return !!ref && (ref.externalKey ? ref.externalKey === item.externalKey : ref.number === item.number);
}
