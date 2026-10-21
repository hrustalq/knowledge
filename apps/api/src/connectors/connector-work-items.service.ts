import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type Connector, type ConnectorWorkItem } from '@prisma/client';
import type {
  ConnectorWorkItemInfo,
  ConnectorWorkItemKind,
  ConnectorWorkItemState,
  CreateConnectorWorkItemInput,
  RepoEventType,
  WorkItemSourceKind,
  WorkItemStatusMap,
  WorkItemSyncState,
} from '@knowledge/contracts';
import { connectorKindInfo, workItemStatusFor } from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import type { AccessScope } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { labelFor, statusMapFor, type TrackerAdapter, type TrackerBoard, type TrackerIssue } from './adapters/tracker.js';
import { TrackerRegistry } from './tracker-registry.service.js';
import { ConnectorAclService } from './connector-acl.service.js';

/**
 * The enabled label-filtered ticket triggers (#433) that cover a connector:
 * one spelling, read by the poll (which connectors to visit) and by
 * `watchLabels` (which tickets to accept), so the two cannot disagree. A
 * trigger naming no connectors covers every one in its workspace.
 */
export function labelTriggersSql(workspaceId: Prisma.Sql, connectorId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT t.filter -> 'labels' AS labels FROM agent_triggers t
     WHERE t.workspace_id = ${workspaceId} AND t.enabled AND t.event = 'work-item.updated'
       AND jsonb_typeof(t.filter -> 'labels') = 'array'
       AND (jsonb_typeof(t.filter -> 'connectorIds') IS DISTINCT FROM 'array'
            OR t.filter -> 'connectorIds' @> jsonb_build_array(${connectorId}::text))`;
}

/**
 * Work items — issues and pull requests — against a connected repository
 * (docs/features/32).
 *
 * The row is a **projection**, never the truth. Everything except `documentId`
 * is overwritten wholesale from the far side on the next read or delivery, which
 * is why there is no local edit path and why `upsertFrom` can be a blind write.
 * The fields we own are the page attachment and, since #424, the anchor and
 * the outbound sync state — the facts the tracker does not have.
 *
 * Every read that returns rows to a caller takes an `AccessScope` (#76): a row
 * on a page the caller cannot open is dropped, and so is a conflict-anchored
 * row whose other page they cannot open. Never a 403, never a title.
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
    private readonly trackers: TrackerRegistry,
    private readonly events: EventsPublisher,
    private readonly activity: ActivityService,
    private readonly permissions: PermissionService,
    private readonly acl: ConnectorAclService,
  ) {}

  /**
   * The connector's work items, refreshed from the far side first.
   *
   * Refresh-then-read rather than read-then-refresh because the webhook is
   * best-effort: a delivery lost while the API was restarting would otherwise
   * leave a stale row on screen with no way for anyone to correct it. A GitHub
   * outage degrades to the stored projection rather than an error page.
   */
  async list(scope: AccessScope, row: Connector): Promise<ConnectorWorkItemInfo[]> {
    await this.refresh(row);
    return this.stored(scope, row.id);
  }

  /** Pull the far side into the stored projection; never fatal (see `list`). */
  private async refresh(row: Connector): Promise<void> {
    const tracker = this.requireTracker(row);
    try {
      const { items } = await tracker.listIssues(row, null);
      const boards = tracker.boardsFor
        ? await tracker.boardsFor(
            row,
            items.map((item) => item.number),
          )
        : new Map<number, string[]>();
      for (const item of items) {
        await this.upsertFrom(row, item, { boards: boards.get(item.number) });
      }
    } catch (err) {
      // Deliberately not fatal. The stored rows are still the last thing the far
      // side told us, and a tab that renders them under a stale timestamp is
      // more use than one that renders an error.
      this.logger.warn(`work item refresh failed for connector ${row.id}: ${(err as Error).message}`);
    }
  }

  /**
   * One page of the tab's list. Only the first page refreshes from the far
   * side: a later page is the reader scrolling through what that refresh just
   * wrote, and asking GitHub again per page would make scrolling cost an API
   * round trip each time.
   *
   * Offset-paged rather than keyset, because the order leads with `state` and a
   * nullable timestamp — a keyset over those would have to spell out NULL
   * handling Prisma's cursor does not. A refresh can shift a row across a page
   * boundary; the client drops the duplicate by id.
   */
  async page(
    scope: AccessScope,
    row: Connector,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ workItems: ConnectorWorkItemInfo[]; total: number; nextCursor: string | null }> {
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    if (offset === 0) await this.refresh(row);
    else this.requireTracker(row);
    const limit = opts.limit ?? 50;
    const [rows, total] = await Promise.all([
      this.prisma.connectorWorkItem.findMany({
        where: { connectorId: row.id },
        orderBy: [{ state: 'asc' }, { externalUpdatedAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: limit + 1,
      }),
      this.prisma.connectorWorkItem.count({ where: { connectorId: row.id } }),
    ]);
    // ponytail: hidden rows still count toward `total` and the page size, so a
    // page can come back short; filter in SQL if restricted pages carry many tickets.
    const page = rows.slice(0, limit);
    return {
      workItems: await this.decorate(await this.visible(scope, page)),
      total,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  /** What is stored, without touching the network. */
  async stored(scope: AccessScope, connectorId: string): Promise<ConnectorWorkItemInfo[]> {
    const rows = await this.prisma.connectorWorkItem.findMany({
      where: { connectorId },
      orderBy: [{ state: 'asc' }, { externalUpdatedAt: 'desc' }],
      take: 200,
    });
    return this.decorate(await this.visible(scope, rows));
  }

  /** The tickets anchored on one knowledge object — the chip's question (#424). */
  async listForAnchor(scope: AccessScope, kind: WorkItemSourceKind, id: string): Promise<ConnectorWorkItemInfo[]> {
    const rows = await this.prisma.connectorWorkItem.findMany({
      where: { workspaceId: scope.workspaceId, sourceKind: kind, sourceId: id },
      orderBy: { createdAt: 'asc' },
      take: MAX_ITEMS_PER_DOCUMENT,
    });
    return this.decorate(await this.visible(scope, rows));
  }

  /**
   * The work items attached to one page. Unscoped and private: its one caller
   * is the `task.update` step, which acts on its run's own root page.
   */
  private async listForDocument(documentId: string): Promise<ConnectorWorkItem[]> {
    return this.prisma.connectorWorkItem.findMany({
      where: { documentId },
      orderBy: { externalUpdatedAt: 'desc' },
      take: MAX_ITEMS_PER_DOCUMENT,
    });
  }

  /**
   * The rows `scope` may see. A row's page must be visible, and a conflict
   * anchor quotes two pages, so its other page must be too.
   */
  async visible(scope: AccessScope, rows: ConnectorWorkItem[]): Promise<ConnectorWorkItem[]> {
    if (scope.bypass || rows.length === 0) return rows;
    const conflictIds = rows.filter((r) => r.sourceKind === 'conflict' && r.sourceId).map((r) => r.sourceId as string);
    const others = new Map<string, string>();
    if (conflictIds.length > 0) {
      const conflicts = await this.prisma.knowledgeConflict.findMany({
        where: { id: { in: conflictIds } },
        select: { id: true, bDocumentId: true },
      });
      for (const c of conflicts) if (c.bDocumentId) others.set(c.id, c.bDocumentId);
    }
    const pages = rows.flatMap((r) => [r.documentId, r.sourceId ? others.get(r.sourceId) : undefined]);
    const visible = await this.permissions.visibleDocumentIds(
      scope,
      pages.filter((id): id is string => Boolean(id)),
    );
    return rows.filter((r) => {
      const other = r.sourceId ? others.get(r.sourceId) : undefined;
      return (!r.documentId || visible.has(r.documentId)) && (!other || visible.has(other));
    });
  }

  /**
   * Open an issue on the far side and record it.
   *
   * This is the outbound handoff, and it is an API-side act on purpose: it
   * attributes work to a person and reaches outside the workspace, which is
   * exactly what the worker is not allowed to do.
   */
  async create(row: Connector, input: CreateConnectorWorkItemInput): Promise<ConnectorWorkItemInfo> {
    const tracker = this.requireTracker(row);
    if (input.documentId) await this.assertDocumentInWorkspace(row, input.documentId);

    const created = await tracker.createIssue(row, {
      title: input.title,
      lines: input.body ? [{ text: input.body }] : [],
      labels: input.labels ?? [],
      assignees: input.assignees,
    });
    const saved = await this.upsertFrom(row, created, { documentId: input.documentId ?? null });
    await this.publish(row, 'repo.issue.opened', saved);
    return (await this.decorate([saved]))[0];
  }

  /**
   * Detach, leaving both sides alone: unlinking says "stop relating these".
   * Drops the anchor too, which stops status sync; the ticket is never closed.
   */
  async unlink(row: Connector, workItemId: string): Promise<ConnectorWorkItemInfo> {
    const existing = await this.require(row, workItemId);
    const updated = await this.prisma.connectorWorkItem.update({
      where: { id: existing.id },
      data: {
        documentId: null,
        sourceKind: null,
        sourceId: null,
        syncState: 'synced',
        pendingStatus: null,
        syncError: null,
        syncAttempts: 0,
        nextSyncAt: null,
      },
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
    item: TrackerIssue,
    opts: { boards?: string[]; actorId?: string | null } = {},
  ): Promise<void> {
    const saved = await this.upsertFrom(row, item, opts);
    await this.publish(row, type, saved);
  }

  /**
   * A tracker delivery on the connector's own webhook (#424, Jira and GitLab).
   * A site-wide hook reports every ticket on the site, so only one we already
   * hold, or one carrying the handoff label, is written.
   */
  async applyTrackerDelivery(row: Connector, item: TrackerIssue, actorId: string | null, labels: string[]): Promise<boolean> {
    const held = await this.prisma.connectorWorkItem.findUnique({
      where: { connectorId_kind_number: { connectorId: row.id, kind: item.kind, number: item.number } },
      select: { id: true },
    });
    const watched = new Set(labels.map((l) => l.toLowerCase()));
    if (!held && !item.labels.some((l) => watched.has(l.toLowerCase()))) return false;
    await this.upsertFrom(row, item, { actorId, announce: true });
    return true;
  }

  /**
   * The labels a poll or a site-wide delivery accepts a ticket by: the handoff
   * label, and every label an enabled ticket trigger covering this connector
   * filters on (#433). Without the second half a Jira ticket carrying only
   * `docs` is never listed, and its trigger never hears it.
   */
  async watchLabels(row: Connector): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ label: string }>>`
      SELECT DISTINCT jsonb_array_elements_text(x.labels) AS label
        FROM (${labelTriggersSql(Prisma.sql`${row.workspaceId}::uuid`, Prisma.sql`${row.id}`)}) x`;
    return [...new Set([labelFor(row), ...rows.map((r) => r.label)])];
  }

  /**
   * Record what a poll read (#424): the projection, and an event only when the
   * ticket is new, or its status or labels moved — a poll re-reads the newest
   * ticket every time.
   */
  async applyPolled(row: Connector, item: TrackerIssue): Promise<ConnectorWorkItem> {
    return this.upsertFrom(row, item, { announce: true });
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
        const tracker = row ? this.trackers.trackerFor(row) : null;
        if (!row || !tracker) continue;
        await tracker.comment(row, item, [{ text: body }]);
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
   * Blind upsert of the far side's state, preserving what we own.
   *
   * `documentId` and the anchor are passed explicitly rather than merged, so
   * that a refresh cannot silently drop a link and an unlink cannot be undone
   * by the next poll.
   *
   * On an anchored row a change of derived status is an activity row (#424),
   * attributed to the tracker account when it maps to a person and to
   * `tracker:<connectorId>` otherwise — never to somebody it does not map to.
   * `announce` also publishes the matching `repo.issue.*` event, for the poll,
   * which has no delivery of its own to announce: a ticket first seen is
   * `opened`, and a relabelled one `labeled` — what a ticket trigger hears (#433).
   */
  async upsertFrom(
    row: Connector,
    item: TrackerIssue,
    opts: {
      boards?: string[];
      documentId?: string | null;
      anchor?: { kind: WorkItemSourceKind; id: string } | null;
      actorId?: string | null;
      announce?: boolean;
      /** No activity row: the change was ours (an outbound transition read back). */
      quiet?: boolean;
    } = {},
  ): Promise<ConnectorWorkItem> {
    const { boards, documentId, anchor } = opts;
    const where = { connectorId_kind_number: { connectorId: row.id, kind: item.kind, number: item.number } };
    const before = await this.prisma.connectorWorkItem.findUnique({ where });
    const shared = {
      title: item.title,
      state: item.state,
      externalKey: item.externalKey,
      externalStatus: item.externalStatus,
      ...(opts.actorId !== undefined ? { externalActorId: opts.actorId } : {}),
      url: item.url,
      authorLogin: item.authorLogin,
      assigneeLogins: item.assigneeLogins,
      labels: item.labels,
      externalCreatedAt: item.externalCreatedAt ? new Date(item.externalCreatedAt) : null,
      externalUpdatedAt: item.externalUpdatedAt ? new Date(item.externalUpdatedAt) : null,
      ...(boards ? { boards } : {}),
      ...(documentId !== undefined ? { documentId } : {}),
      ...(anchor !== undefined ? { sourceKind: anchor?.kind ?? null, sourceId: anchor?.id ?? null } : {}),
    };
    const saved = await this.prisma.connectorWorkItem.upsert({
      where,
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

    const map = this.mapFor(row);
    const was = before ? workItemStatusFor(before, map) : null;
    const now = workItemStatusFor(saved, map);
    if (opts.announce && (!before || (was === now && labelsMoved(before.labels, saved.labels)))) {
      await this.publish(row, before ? 'repo.issue.labeled' : 'repo.issue.opened', saved);
    }
    if (before && was !== now) {
      if (saved.sourceKind && !opts.quiet) {
        void this.activity.record({
          workspaceId: row.workspaceId,
          actor: await this.actorFor(row, saved.externalActorId),
          action: 'connector.work-item.status-changed',
          subjectId: saved.id,
          ...(saved.documentId ? { documentId: saved.documentId } : {}),
          metadata: { key: keyOf(saved), from: was, to: now, externalStatus: saved.externalStatus, url: saved.url },
        });
      }
      if (opts.announce) {
        const type: RepoEventType =
          now === 'done' || now === 'wont_do' ? 'repo.issue.closed' : was === 'done' || was === 'wont_do' ? 'repo.issue.reopened' : 'repo.issue.labeled';
        await this.publish(row, type, saved);
      }
    }
    return saved;
  }

  /**
   * Who a tracker account is here, for attribution only: the person
   * `external_identities` maps it to, else `tracker:<connectorId>`.
   */
  async actorFor(row: Connector, externalId: string | null): Promise<string> {
    if (externalId) {
      let mapped = await this.prisma.externalIdentity.findUnique({
        where: { connectorId_externalId: { connectorId: row.id, externalId } },
        select: { userId: true },
      });
      if (!mapped) {
        // First sighting: record the account so an admin can map it on the
        // connector page, and let the resolver try a linked GitHub account
        // or a verified email first.
        await this.prisma.externalIdentity.createMany({
          data: [{ workspaceId: row.workspaceId, connectorId: row.id, externalId }],
          skipDuplicates: true,
        });
        await this.acl.resolveIdentities(row, [externalId]).catch(() => 0);
        mapped = await this.prisma.externalIdentity.findUnique({
          where: { connectorId_externalId: { connectorId: row.id, externalId } },
          select: { userId: true },
        });
      }
      if (mapped?.userId) return mapped.userId;
    }
    return `tracker:${row.id}`;
  }

  /**
   * The board a row's card is kept on: the tracker route of the row's page's
   * project, when it routes to this row's connector and names a board.
   */
  async boardFor(item: Pick<ConnectorWorkItem, 'connectorId' | 'documentId'>): Promise<TrackerBoard | null> {
    if (!item.documentId) return null;
    const doc = await this.prisma.document.findUnique({ where: { id: item.documentId }, select: { projectId: true } });
    const route = doc ? await this.prisma.projectTrackerRoute.findUnique({ where: { projectId: doc.projectId } }) : null;
    if (!route || route.connectorId !== item.connectorId || !route.boardNodeId || !route.boardFieldId) return null;
    return { nodeId: route.boardNodeId, fieldId: route.boardFieldId };
  }

  /** The connector's status map: its config override over its tracker's default. */
  mapFor(row: Connector): WorkItemStatusMap {
    return statusMapFor(row, this.trackers.trackerFor(row)?.kind ?? 'github');
  }

  /** The row's tracker, or null for a kind or host with none. */
  trackerOf(row: Connector): TrackerAdapter | null {
    return this.trackers.trackerFor(row);
  }

  /** The row's tracker, or the 400 the tab has always answered for a kind with none. */
  requireTracker(row: Connector): TrackerAdapter {
    const tracker = this.trackers.trackerFor(row);
    if (!tracker) {
      if (connectorKindInfo(row.kind)?.capabilities.tasks) {
        throw new BadRequestException(t('error.connector.workItemsGithubOnly'));
      }
      throw new BadRequestException(t('error.connector.workItemsUnsupported', { kind: row.kind }));
    }
    return tracker;
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

  async require(row: Connector, workItemId: string): Promise<ConnectorWorkItem> {
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

  async decorate(rows: ConnectorWorkItem[]): Promise<ConnectorWorkItemInfo[]> {
    const ids = [...new Set(rows.map((r) => r.documentId).filter((id): id is string => Boolean(id)))];
    const titles = new Map<string, string>();
    if (ids.length > 0) {
      const docs = await this.prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
      for (const doc of docs) titles.set(doc.id, doc.title);
    }
    const maps = new Map<string, WorkItemStatusMap>();
    const connectorIds = [...new Set(rows.map((r) => r.connectorId))];
    if (connectorIds.length > 0) {
      const connectors = await this.prisma.connector.findMany({ where: { id: { in: connectorIds } } });
      for (const c of connectors) maps.set(c.id, this.mapFor(c));
    }
    return rows.map((row) =>
      toWorkItemInfo(row, row.documentId ? (titles.get(row.documentId) ?? null) : null, maps.get(row.connectorId)),
    );
  }
}

/** Defensive read of a Json column: a bad value degrades to empty, never throws into a request. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `BILL-123` for Jira, `#412` for a repository tracker. */
export function keyOf(row: Pick<ConnectorWorkItem, 'externalKey' | 'number'>): string {
  return row.externalKey ?? `#${row.number}`;
}

export function toWorkItemInfo(
  row: ConnectorWorkItem,
  documentTitle: string | null,
  map: WorkItemStatusMap = statusMapFor(null, 'github'),
): ConnectorWorkItemInfo {
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
    key: keyOf(row),
    sourceKind: row.sourceKind as WorkItemSourceKind | null,
    sourceId: row.sourceId,
    status: workItemStatusFor(row, map),
    externalStatus: row.externalStatus,
    syncState: row.syncState as WorkItemSyncState,
    syncError: row.syncError,
  };
}

/** Whether two stored label lists differ as sets. */
function labelsMoved(a: unknown, b: unknown): boolean {
  const set = (v: unknown) => [...new Set(Array.isArray(v) ? v.map(String) : [])].sort().join('\n');
  return set(a) !== set(b);
}
