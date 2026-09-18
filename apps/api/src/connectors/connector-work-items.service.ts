import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Connector, ConnectorWorkItem } from '@prisma/client';
import type {
  ConnectorWorkItemInfo,
  ConnectorWorkItemKind,
  ConnectorWorkItemState,
  CreateConnectorWorkItemInput,
  RepoEventType,
} from '@knowledge/contracts';
import { connectorKindInfo } from '@knowledge/contracts';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GithubIssuesService, type GithubWorkItem } from './github/github-issues.service.js';

/**
 * Work items — issues and pull requests — against a connected repository
 * (docs/features/32).
 *
 * The row is a **projection**, never the truth. Everything except `documentId`
 * is overwritten wholesale from the far side on the next read or delivery, which
 * is why there is no local edit path and why `upsertFrom` can be a blind write.
 * The one field we own is the page attachment, because that is the one fact
 * GitHub does not have.
 *
 * Kept apart from `ConnectorLinksService` for the reason the tables are apart:
 * that one answers "is this page in sync", this one answers "is this task done",
 * and a single service answering both would have to decide which meaning
 * `externalId` carries on any given row.
 */

/** A page may be about several issues; past this the rail is a list, not a fact. */
const MAX_ITEMS_PER_DOCUMENT = 50;

@Injectable()
export class ConnectorWorkItemsService {
  private readonly logger = new Logger(ConnectorWorkItemsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubIssuesService,
    private readonly events: EventsPublisher,
  ) {}

  /**
   * The connector's work items, refreshed from the far side first.
   *
   * Refresh-then-read rather than read-then-refresh because the webhook is
   * best-effort: a delivery lost while the API was restarting would otherwise
   * leave a stale row on screen with no way for anyone to correct it. A GitHub
   * outage degrades to the stored projection rather than an error page.
   */
  async list(row: Connector): Promise<ConnectorWorkItemInfo[]> {
    this.assertSupported(row);
    try {
      const fetched = await this.github.list(row);
      const boards = await this.github.boardsFor(
        row,
        fetched.map((item) => item.number),
      );
      for (const item of fetched) {
        await this.upsertFrom(row, item, boards.get(item.number));
      }
    } catch (err) {
      // Deliberately not fatal. The stored rows are still the last thing the far
      // side told us, and a tab that renders them under a stale timestamp is
      // more use than one that renders an error.
      this.logger.warn(`work item refresh failed for connector ${row.id}: ${(err as Error).message}`);
    }
    return this.stored(row.id);
  }

  /** What is stored, without touching the network — the webhook's read path. */
  async stored(connectorId: string): Promise<ConnectorWorkItemInfo[]> {
    const rows = await this.prisma.connectorWorkItem.findMany({
      where: { connectorId },
      orderBy: [{ state: 'asc' }, { externalUpdatedAt: 'desc' }],
      take: 200,
    });
    return this.decorate(rows);
  }

  /** The work items attached to one page — the document rail's question. */
  async listForDocument(documentId: string): Promise<ConnectorWorkItemInfo[]> {
    const rows = await this.prisma.connectorWorkItem.findMany({
      where: { documentId },
      orderBy: { externalUpdatedAt: 'desc' },
      take: MAX_ITEMS_PER_DOCUMENT,
    });
    return this.decorate(rows);
  }

  /**
   * Open an issue on the far side and record it.
   *
   * This is the outbound handoff, and it is an API-side act on purpose: it
   * attributes work to a person and reaches outside the workspace, which is
   * exactly what the worker is not allowed to do.
   */
  async create(row: Connector, input: CreateConnectorWorkItemInput): Promise<ConnectorWorkItemInfo> {
    this.assertSupported(row);
    if (input.documentId) await this.assertDocumentInWorkspace(row, input.documentId);

    const created = await this.github.create(row, input);
    const saved = await this.upsertFrom(row, created, undefined, input.documentId ?? null);
    await this.publish(row, 'repo.issue.opened', saved);
    return (await this.decorate([saved]))[0];
  }

  /** Attach a work item to a page — what makes a repo event able to reach a flow. */
  async link(row: Connector, workItemId: string, documentId: string): Promise<ConnectorWorkItemInfo> {
    await this.assertDocumentInWorkspace(row, documentId);
    const existing = await this.require(row, workItemId);
    const updated = await this.prisma.connectorWorkItem.update({
      where: { id: existing.id },
      data: { documentId },
    });
    return (await this.decorate([updated]))[0];
  }

  /** Detach, leaving both sides alone: unlinking says "stop relating these". */
  async unlink(row: Connector, workItemId: string): Promise<ConnectorWorkItemInfo> {
    const existing = await this.require(row, workItemId);
    const updated = await this.prisma.connectorWorkItem.update({
      where: { id: existing.id },
      data: { documentId: null },
    });
    return (await this.decorate([updated]))[0];
  }

  /**
   * Record what a webhook delivery said, and announce it.
   *
   * The published frame carries the linked page's id when there is one, which is
   * the whole mechanism behind repo-event workflow triggers: `WorkflowTriggerService`
   * already resolves a run's root page from `event.documentId`, so an attached
   * work item reaches a flow through the path every other event uses, and an
   * unattached one reaches nothing. That is the intended asymmetry — a workflow
   * runs against a page, and an issue nobody connected to a page has none.
   */
  async applyDelivery(
    row: Connector,
    type: RepoEventType,
    item: GithubWorkItem,
    boards?: string[],
  ): Promise<void> {
    const saved = await this.upsertFrom(row, item, boards);
    await this.publish(row, type, saved);
  }

  /**
   * Comment on every open work item attached to a page, and say how many were
   * reached (docs/features/32).
   *
   * Here rather than assembled at the call site: the `task.update` workflow
   * step wanted "comment on this page's issues", and expressing that as a
   * connector lookup plus a GitHub call meant the worker module had to import
   * the connector core module for a row it only passes straight back. One
   * method keeps the dependency at the layer that owns work items — and the
   * worker fails at boot if that ever stops being true.
   *
   * One item refusing does not fail the rest: a comment is a courtesy on top of
   * whatever the caller already did, and half of it landing beats none.
   */
  async commentOnDocument(documentId: string, body: string, max: number): Promise<number> {
    const open = (await this.listForDocument(documentId)).filter((item) => item.state === 'open');
    let commented = 0;
    for (const item of open.slice(0, max)) {
      try {
        const row = await this.prisma.connector.findUnique({ where: { id: item.connectorId } });
        if (!row) continue;
        await this.github.comment(row, item.number, body);
        commented += 1;
      } catch (err) {
        this.logger.warn(`could not comment on #${item.number}: ${(err as Error).message}`);
      }
    }
    return commented;
  }

  /** Announce something with no work item of its own — a push, a release. */
  async publishBare(row: Connector, type: RepoEventType, title: string): Promise<void> {
    await this.events.publish({ type, workspaceId: row.workspaceId, subjectId: row.id, title });
  }

  // --- internals ---

  /**
   * Blind upsert of the far side's state, preserving only the page attachment.
   *
   * `documentId` is passed explicitly rather than merged, so that a refresh
   * cannot silently drop a link and an unlink cannot be undone by the next poll.
   */
  private async upsertFrom(
    row: Connector,
    item: GithubWorkItem,
    boards?: string[],
    documentId?: string | null,
  ): Promise<ConnectorWorkItem> {
    const shared = {
      title: item.title,
      state: item.state,
      url: item.url,
      authorLogin: item.authorLogin,
      assigneeLogins: item.assigneeLogins,
      labels: item.labels,
      externalCreatedAt: item.externalCreatedAt ? new Date(item.externalCreatedAt) : null,
      externalUpdatedAt: item.externalUpdatedAt ? new Date(item.externalUpdatedAt) : null,
      ...(boards ? { boards } : {}),
      ...(documentId !== undefined ? { documentId } : {}),
    };
    return this.prisma.connectorWorkItem.upsert({
      where: { connectorId_kind_number: { connectorId: row.id, kind: item.kind, number: item.number } },
      create: {
        connectorId: row.id,
        workspaceId: row.workspaceId,
        kind: item.kind,
        number: item.number,
        boards: boards ?? [],
        documentId: documentId ?? null,
        ...shared,
      },
      update: shared,
    });
  }

  private async publish(row: Connector, type: RepoEventType, item: ConnectorWorkItem): Promise<void> {
    await this.events.publish({
      type,
      workspaceId: row.workspaceId,
      subjectId: item.id,
      title: item.title,
      ...(item.documentId ? { documentId: item.documentId } : {}),
    });
  }

  private async require(row: Connector, workItemId: string): Promise<ConnectorWorkItem> {
    const found = await this.prisma.connectorWorkItem.findUnique({ where: { id: workItemId } });
    // Belongs-to check rather than a bare lookup: the id arrives from a client,
    // and `@Access` resolved the workspace from the *connector*, not from this.
    if (!found || found.connectorId !== row.id) {
      throw new NotFoundException(t('error.connector.workItemNotFound', { id: workItemId }));
    }
    return found;
  }

  /**
   * A page can only be attached to a connector in its own workspace.
   *
   * The `@Access` guard resolved the workspace from the connector id in the
   * path; nothing has yet checked the document id in the body, and without this
   * a linked page from another tenant would start receiving that tenant's issue
   * events.
   */
  private async assertDocumentInWorkspace(row: Connector, documentId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true },
    });
    if (!doc || doc.workspaceId !== row.workspaceId) {
      throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    }
  }

  private assertSupported(row: Connector): void {
    if (!connectorKindInfo(row.kind)?.capabilities.tasks) {
      throw new BadRequestException(t('error.connector.workItemsUnsupported', { kind: row.kind }));
    }
  }

  private async decorate(rows: ConnectorWorkItem[]): Promise<ConnectorWorkItemInfo[]> {
    const ids = [...new Set(rows.map((r) => r.documentId).filter((id): id is string => Boolean(id)))];
    const titles = new Map<string, string>();
    if (ids.length > 0) {
      const docs = await this.prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
      for (const doc of docs) titles.set(doc.id, doc.title);
    }
    return rows.map((row) => toWorkItemInfo(row, row.documentId ? (titles.get(row.documentId) ?? null) : null));
  }
}

/** Defensive read of a Json column: a bad value degrades to empty, never throws into a request. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function toWorkItemInfo(row: ConnectorWorkItem, documentTitle: string | null): ConnectorWorkItemInfo {
  return {
    id: row.id,
    connectorId: row.connectorId,
    kind: row.kind as ConnectorWorkItemKind,
    number: row.number,
    title: row.title,
    state: row.state as ConnectorWorkItemState,
    url: row.url,
    authorLogin: row.authorLogin,
    assigneeLogins: strings(row.assigneeLogins),
    labels: strings(row.labels),
    documentId: row.documentId,
    documentTitle,
    boards: strings(row.boards),
    externalCreatedAt: row.externalCreatedAt?.toISOString() ?? null,
    externalUpdatedAt: row.externalUpdatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
