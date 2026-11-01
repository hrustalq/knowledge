import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector, ConnectorLink, ConnectorRun } from '@prisma/client';
import {
  SOURCE_DEFAULT_INTERVAL_MIN,
  SOURCE_FAILURE_LIMIT,
  SOURCE_INTERVALS_MIN,
  SOURCE_RETRY_DELAYS_MIN,
  webCrawls,
  type CreateSourcePageRequest,
  type CreateSourcePageResponse,
  type DocumentSourceInfo,
  type DocumentSourceWebhookResponse,
  type Locale,
  type SourceAlertKind,
  type SourceCheckFailure,
  type SourceRecipePreview,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VerificationService } from '../verification/verification.service.js';
import { ConnectorRequestError } from './adapters/connector.types.js';
import { isGone, isTransient, isUnsupported, retryAfterMs } from './adapters/web-failures.js';
import { composeMarkdown, sha256 } from './connector-markdown.js';
import { ConnectorProducer } from './connector.producer.js';
import { ConnectorsService } from './connectors.service.js';
import type { SourceBody } from './source-recipe.js';
import { SourceRecipesService } from './source-recipes.service.js';
import { SourceSettingsService } from './source-settings.service.js';

/** The system's own actor id, used when a connector's owner was deleted. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/**
 * Source-backed pages (#674, phase 1): a page whose body belongs to a `web`
 * source, written only by that source's connector.
 *
 * Two halves in one controller-free service. The **sync hooks** (`checked`,
 * `countAhead`, `fetchFailed`, `updated`, `afterRun`) are called by staging and
 * the run's finish, in the worker. The **page operations** (link, pause,
 * resume, restore, webhook) are the source panel's, in the API.
 */
@Injectable()
export class WebSourcesService {
  private readonly logger = new Logger(WebSourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly connectors: ConnectorsService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageService,
    private readonly verification: VerificationService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
    private readonly producer: ConnectorProducer,
    private readonly recipes: SourceRecipesService,
    private readonly settings: SourceSettingsService,
  ) {}

  // ------------------------------------------------------------ sync hooks

  /** The source answered: failures, gone counts and any pending retry are over. */
  async checked(link: ConnectorLink): Promise<void> {
    if (link.failures === 0 && link.goneCount === 0 && link.retryAttempt === 0 && !link.retryAt) return;
    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: { failures: 0, goneCount: 0, retryAttempt: 0, retryAt: null },
    });
  }

  /**
   * A fetched version through the page's extraction recipe (phase 2): the
   * markdown to write, or null when its checks failed and it is held — the
   * owner is alerted on the way in, not on every held sync after.
   */
  async read(row: Connector, link: ConnectorLink, source: SourceBody): Promise<string | null> {
    const read = await this.recipes.read(row, link, source);
    if (!read.held) return read.markdown;
    if (read.newlyHeld) await this.alert(row, link.documentId, 'held');
    return null;
  }

  /** A paused page writes nothing; a version it has not counted yet is one more it is behind. */
  async countAhead(link: ConnectorLink, hash: string): Promise<void> {
    if (hash === link.contentHash || hash === link.aheadHash) return;
    await this.prisma.connectorLink.updateMany({
      where: { id: link.id, aheadHash: link.aheadHash },
      data: { aheadCount: { increment: 1 }, aheadHash: hash, lastPulledAt: new Date() },
    });
  }

  /**
   * A fetch failed. Returns true when the failure was handled and the item
   * should read as unchanged (the source is gone and the page now archived);
   * otherwise the caller rethrows and the item fails.
   *
   * - 404/410 counts toward archiving, never toward a failed sync.
   * - A transient failure schedules a retry at 1, 5 and 25 minutes
   *   (`Retry-After` can only lengthen one); `afterRun` queues it.
   * - An unsupported body is held for recipe review, never retried.
   * - Anything else, and exhausted retries, is a failed sync.
   */
  async fetchFailed(row: Connector, link: ConnectorLink, err: unknown): Promise<boolean> {
    // Not markdown, not HTML: a parse failure, never retried — held for review (phase 2).
    if (isUnsupported(err)) {
      if (await this.recipes.unsupported(link)) await this.alert(row, link.documentId, 'held');
      return true;
    }
    if (isGone(err)) {
      const goneCount = link.goneCount + 1;
      await this.prisma.connectorLink.update({ where: { id: link.id }, data: { goneCount } });
      if (goneCount < SOURCE_FAILURE_LIMIT) return false;
      await this.archiveGone(row, link);
      return true;
    }
    if (isTransient(err) && link.retryAttempt < SOURCE_RETRY_DELAYS_MIN.length) {
      const delay = Math.max(SOURCE_RETRY_DELAYS_MIN[link.retryAttempt]! * 60_000, retryAfterMs(err));
      await this.prisma.connectorLink.update({
        where: { id: link.id },
        data: { retryAttempt: link.retryAttempt + 1, retryAt: new Date(Date.now() + delay) },
      });
      return false;
    }
    const failures = link.failures + 1;
    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: { failures, retryAttempt: 0, retryAt: null },
    });
    // Once, on the run that reaches the limit, not on every run after it.
    if (failures === SOURCE_FAILURE_LIMIT) await this.alert(row, link.documentId, 'failing');
    return false;
  }

  /** A new version landed: the connector's owner hears; watchers hear through `revision.finalized`. */
  updated(row: Connector, documentId: string): Promise<void> {
    return this.tell(row, documentId, 'source.updated', 'owner', {});
  }

  /**
   * A finished run queues the retries its failures asked for, each a scoped
   * run delayed to its `retry_at` — the run is over, so the connector's one
   * in-flight slot is free. A lost delayed job is re-enqueued by the
   * schedule sweeper's relay under the same job id.
   *
   * A complete crawl (phase 3) also counts the pages that dropped out of the
   * tree toward archiving, the way a 404 does: three crawls in a row without
   * a page archive it and flag its dependents.
   */
  async afterRun(row: Connector, run: ConnectorRun): Promise<void> {
    for (const link of (await this.dropped(row, run)) ?? []) {
      const goneCount = link.goneCount + 1;
      await this.prisma.connectorLink.update({ where: { id: link.id }, data: { goneCount } });
      if (goneCount >= SOURCE_FAILURE_LIMIT) await this.archiveGone(row, link);
    }

    const due = await this.prisma.connectorLink.findMany({
      where: { connectorId: row.id, retryAt: { not: null } },
      select: { externalId: true, retryAt: true },
    });
    if (due.length === 0) return;
    const at = Math.min(...due.map((l) => l.retryAt!.getTime()));
    try {
      const run = await this.connectors.createRun(row, 'pull', 'schedule', { externalIds: due.map((l) => l.externalId) });
      await this.producer.enqueue(run.id, { delayMs: Math.max(0, at - Date.now()) });
    } catch (err) {
      this.logger.warn({ msg: 'Source retry could not be queued', connectorId: row.id, err });
    }
  }

  /**
   * Why an unattended crawl waits for a person (phase 3), or null to apply it:
   * a first crawl creating more than `confirmFirst` pages, or a later one
   * adding plus dropping more than `confirmChange`. Read once the run's pages
   * are staged, before anything is written.
   */
  async confirmation(row: Connector, run: ConnectorRun): Promise<string | null> {
    if (!webCrawls(row.config) || Array.isArray(run.scope)) return null;
    const [limits, links, added] = await Promise.all([
      this.settings.limits(row.workspaceId),
      this.prisma.connectorLink.count({ where: { connectorId: row.id } }),
      this.prisma.connectorRunItem.count({ where: { runId: run.id, status: 'staged', action: 'create' } }),
    ]);
    // A page linked by "Link a source" already has its root page.
    if (links <= 1) {
      return added > limits.confirmFirst ? t('connector.warning.crawlConfirmFirst', { count: added, limit: limits.confirmFirst }) : null;
    }
    const dropped = (await this.dropped(row, run))?.length ?? 0;
    return added + dropped > limits.confirmChange
      ? t('connector.warning.crawlConfirmChange', { added, dropped, limit: limits.confirmChange })
      : null;
  }

  /**
   * The live pages a crawl did not find, or null when the run cannot say: a
   * scoped run (a retry), one stopped at the page cap, or one whose root
   * failed. A page found but held, or failing on its own, was found.
   */
  private async dropped(row: Connector, run: ConnectorRun): Promise<ConnectorLink[] | null> {
    if (!webCrawls(row.config) || Array.isArray(run.scope)) return null;
    const root = (row.config as Record<string, unknown>).url;
    const cap = Math.min((await this.settings.limits(row.workspaceId)).maxPages, this.config.get('CONNECTOR_SYNC_MAX_ITEMS', { infer: true }));
    const items = await this.prisma.connectorRunItem.findMany({ where: { runId: run.id }, select: { externalId: true, status: true } });
    if (items.length >= cap || !items.some((i) => i.externalId === root && i.status !== 'failed')) return null;
    const found = new Set(items.map((i) => i.externalId));
    const absent = (await this.prisma.connectorLink.findMany({ where: { connectorId: row.id } })).filter((l) => !found.has(l.externalId));
    if (absent.length === 0) return [];
    const live = await this.prisma.document.findMany({
      where: { id: { in: absent.map((l) => l.documentId) }, archivedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((d) => d.id));
    return absent.filter((l) => liveIds.has(l.documentId));
  }

  /**
   * Three 404/410s in a row: the page is archived, and every page that links
   * to it is flagged `outdated` with the reason "source removed".
   */
  private async archiveGone(row: Connector, link: ConnectorLink): Promise<void> {
    const actorId = row.createdBy ?? AUTHOR_ID_STUB;
    const document = await this.prisma.document.findUnique({ where: { id: link.documentId }, select: { title: true, archivedAt: true } });
    if (!document || document.archivedAt) return;
    await this.verification.archive(link.documentId, actorId, false);
    const dependents = await this.prisma.pageLink.findMany({
      where: { workspaceId: row.workspaceId, targetDocumentId: link.documentId, sourceDocumentId: { not: link.documentId } },
      select: { sourceDocumentId: true },
      distinct: ['sourceDocumentId'],
    });
    for (const { sourceDocumentId } of dependents) {
      await this.verification
        .flag(sourceDocumentId, 'outdated', {
          actorId,
          note: t('connector.sourceRemovedNote', { title: document.title }),
          source: { kind: 'source', by: actorId },
          keepOutdated: true,
        })
        .catch((err: unknown) => this.logger.warn({ msg: 'Dependent page could not be flagged', sourceDocumentId, err }));
    }
    await this.alert(row, link.documentId, 'gone');
  }

  /** In-app plus email (reason `alert`), to the connector's owner. */
  private alert(row: Connector, documentId: string, kind: SourceAlertKind): Promise<void> {
    return this.tell(row, documentId, 'source.alert', 'alert', { alert: kind });
  }

  /** One row to the connector's owner, who may be gone (a deleted creator). */
  private async tell(
    row: Connector,
    documentId: string,
    type: 'source.updated' | 'source.alert',
    reason: 'owner' | 'alert',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!row.createdBy) return;
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, select: { title: true } });
    const delivered = await this.notifications.notify({
      workspaceId: row.workspaceId,
      userIds: [row.createdBy],
      type,
      reason,
      actor: null,
      documentId,
      subjectType: 'document',
      subjectId: documentId,
      title: document?.title ?? null,
      metadata: { ...metadata, host: hostOf(row) },
    });
    await this.events.announce(row.workspaceId, delivered);
  }

  // ------------------------------------------------------------ page operations

  /**
   * "Add page → Link a source": the first version is read in the request, so
   * the person gets a page or an error now rather than a run to watch. The
   * page, its hidden connector and the link commit together.
   */
  async link(input: CreateSourcePageRequest, userId: string): Promise<CreateSourcePageResponse> {
    this.connectors.assertKindEnabled('web');
    const url = input.url.trim();
    const interval = checkInterval(input.intervalMinutes === undefined ? SOURCE_DEFAULT_INTERVAL_MIN : input.intervalMinutes);
    const site = originOf(url);
    // The same host never asks twice: its connection is reused unless a new credential is given.
    const known = input.credential
      ? null
      : await this.prisma.connection.findFirst({
          where: { workspaceId: input.workspaceId, provider: 'web', site, method: 'token' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });

    const summary = await this.connectors.create(
      {
        workspaceId: input.workspaceId,
        kind: 'web',
        name: `source:${randomUUID()}`,
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        category: 'reference',
        config: { url, ...(input.crawl ? { crawl: 'tree' } : {}) },
        ...(input.credential ? { credential: input.credential } : {}),
        ...(known ? { connectionId: known.id } : {}),
        syncIntervalMinutes: interval,
      },
      userId,
    );
    const row = await this.connectors.require(summary.id);

    let doc;
    try {
      const ctx = await this.connectors.contextFor(row, async () => undefined);
      doc = await this.connectors.adapterFor(row).fetch(ctx, { externalId: url, title: url, url });
    } catch (err) {
      await this.prisma.connector.delete({ where: { id: row.id } }).catch(() => undefined);
      const status = err instanceof ConnectorRequestError ? err.status : null;
      if (status === 401 || status === 403) {
        throw new BadRequestException({ statusCode: 400, message: t('error.source.needsCredential', { status }), needsCredential: true });
      }
      // The status alone: the person just typed the URL, and the upstream body is not theirs to read.
      const detail = status !== null ? `HTTP ${status}` : (err as Error).message.slice(0, 300);
      throw new BadRequestException({ statusCode: 400, message: t('error.source.unreadable', { detail }) });
    }

    const markdown = composeMarkdown(doc);
    const created = this.prisma.withTransaction(
      async () => {
        const created = await this.documents.createDocument(
          {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            ...(input.parentId ? { parentId: input.parentId } : {}),
            title: input.title?.trim() || doc.title || url,
            category: 'reference',
            content: { mode: 'inline', format: 'markdown', text: markdown },
          },
          userId,
        );
        await this.prisma.connectorLink.create({
          data: {
            connectorId: row.id,
            workspaceId: row.workspaceId,
            documentId: created.documentId,
            externalId: url,
            externalUrl: doc.ref.url ?? url,
            externalTitle: doc.title,
            externalVersion: doc.ref.version ?? null,
            contentHash: sha256(markdown),
            revisionId: created.revisionId,
            lastPulledAt: new Date(),
          },
        });
        // A crawled tree nests under this page; a page whose path parent was never found lands here too.
        await this.prisma.connector.update({
          where: { id: row.id },
          data: { ownerDocumentId: created.documentId, lastSyncedAt: new Date(), ...(input.crawl ? { parentId: created.documentId } : {}) },
        });
        return { documentId: created.documentId, connectorId: row.id };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    // A connector with no page would show up in the Connectors list as a stray.
    const result = await created.catch(async (err: unknown) => {
      await this.prisma.connector.delete({ where: { id: row.id } }).catch(() => undefined);
      throw err;
    });
    // The first version is the baseline the next one is checked against, and the body a recipe previews on.
    if (doc.source) {
      const linkRow = await this.prisma.connectorLink.findFirstOrThrow({ where: { connectorId: row.id } });
      await this.recipes.read(row, linkRow, doc.source).catch((err: unknown) =>
        this.logger.warn({ msg: 'Source baseline not recorded', connectorId: row.id, err: String(err) }),
      );
    }
    // The rest of the tree arrives by a run: the person gets their page now, and the crawl fills in under it.
    if (input.crawl) {
      const run = await this.connectors.createRun(row, 'pull', 'manual', { actorId: userId });
      await this.producer.enqueue(run.id);
    }
    return result;
  }

  async info(documentId: string): Promise<DocumentSourceInfo> {
    const { row, link } = await this.require(documentId);
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, include: { branches: true } });
    const head = document?.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? null;
    const url = link.externalUrl ?? link.externalId;
    return {
      documentId,
      connectorId: row.id,
      url,
      host: new URL(url).host,
      intervalMinutes: row.syncIntervalMinutes,
      pausedAt: link.pausedAt?.toISOString() ?? null,
      aheadCount: link.aheadCount,
      lastCheckedAt: link.lastPulledAt?.toISOString() ?? null,
      syncedRevisionId: link.revisionId,
      headRevisionId: head,
      failures: link.failures,
      retryAt: link.retryAt?.toISOString() ?? null,
      webhookConfigured: row.webhookSecret !== null,
      recipe: await this.recipes.state(link),
      tree: await this.tree(row),
    };
  }

  /** A crawled source's root page, its page count and any run waiting to be confirmed (phase 3). */
  private async tree(row: Connector): Promise<DocumentSourceInfo['tree']> {
    if (!webCrawls(row.config)) return null;
    const root = (row.config as Record<string, unknown>).url as string;
    const [rootLink, links, awaiting] = await Promise.all([
      this.prisma.connectorLink.findFirst({ where: { connectorId: row.id, externalId: root }, select: { documentId: true } }),
      this.prisma.connectorLink.findMany({ where: { connectorId: row.id }, select: { documentId: true } }),
      this.prisma.connectorRun.findFirst({ where: { connectorId: row.id, status: 'awaiting-review' }, select: { id: true } }),
    ]);
    // Live pages only: one archived as dropped from the tree is no longer synced.
    const pages = await this.prisma.document.count({ where: { id: { in: links.map((l) => l.documentId) }, archivedAt: null } });
    const rootDocumentId = row.ownerDocumentId ?? rootLink?.documentId ?? null;
    return rootDocumentId ? { rootDocumentId, pages, awaitingRunId: awaiting?.id ?? null } : null;
  }

  async setInterval(documentId: string, intervalMinutes: number | null): Promise<DocumentSourceInfo> {
    const { row } = await this.require(documentId);
    await this.prisma.connector.update({ where: { id: row.id }, data: { syncIntervalMinutes: checkInterval(intervalMinutes) } });
    return this.info(documentId);
  }

  async pause(documentId: string): Promise<DocumentSourceInfo> {
    const { link } = await this.require(documentId);
    await this.prisma.connectorLink.updateMany({ where: { id: link.id, pausedAt: null }, data: { pausedAt: new Date() } });
    return this.info(documentId);
  }

  /**
   * Back to following the source: the agreed hash and validators are
   * dropped, so the next sync fetches in full and writes whatever the source
   * says now — over a restored revision too. That sync is queued at once.
   */
  async resume(documentId: string, actorId: string): Promise<DocumentSourceInfo> {
    const { row, link } = await this.require(documentId);
    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: { pausedAt: null, aheadCount: 0, aheadHash: null, contentHash: null, externalVersion: null },
    });
    try {
      const run = await this.connectors.createRun(row, 'pull', 'manual', { actorId });
      await this.producer.enqueue(run.id);
    } catch (err) {
      // A run already in flight picks the resumed link up.
      if (!(err instanceof ConflictException)) throw err;
    }
    return this.info(documentId);
  }

  /**
   * Restore an earlier revision: written as a new revision by the page's own
   * connector (nobody else may write it), and the source paused so the next
   * sync does not undo it. The owner is alerted.
   */
  async restore(documentId: string, revisionId: string, actorId: string): Promise<DocumentSourceInfo> {
    const { row, link } = await this.require(documentId);
    const revision = await this.prisma.documentRevision.findFirst({
      // Any revision with stored bytes: one whose indexing failed is still the page as it read.
      where: { id: revisionId, documentId, status: { not: 'draft' } },
    });
    if (!revision) throw new BadRequestException(t('error.source.revisionNotOfPage', { id: revisionId }));
    const markdown = await this.storage.getObjectText(revision.s3Key);

    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: { pausedAt: link.pausedAt ?? new Date(), aheadCount: 0, aheadHash: null },
    });
    const draft = await this.documents.createRevision(
      documentId,
      { message: t('connector.sourceRestoredMessage', { number: revision.revisionNumber }), contentType: revision.contentType },
      undefined,
      actorId,
      { connectorId: row.id },
    );
    const stored = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
    await this.storage.putObjectText(stored.s3Key, markdown, stored.contentType);
    await this.documents.finalizeRevision(documentId, draft.revisionId);
    await this.alert(row, documentId, 'paused');
    return this.info(documentId);
  }

  // ------------------------------------------------------------ extraction recipes (phase 2)

  async previewRecipe(documentId: string, recipe: unknown): Promise<SourceRecipePreview> {
    const { link } = await this.require(documentId);
    return this.recipes.preview(link, recipe);
  }

  /** Save (or approve) a recipe; the current version is re-read through it. */
  async saveRecipe(documentId: string, recipe: unknown, proposalId: string | undefined, userId: string): Promise<DocumentSourceInfo> {
    const { row, link } = await this.require(documentId);
    await this.recipes.save(row, link, recipe, proposalId, userId);
    return this.info(documentId);
  }

  /** The agent drafts a recipe for the last fetched version, on a person's ask. */
  async draftRecipe(documentId: string, userId: string, locale: Locale): Promise<DocumentSourceInfo> {
    const { row, link } = await this.require(documentId);
    const failures = (link.heldReason ? link.heldReason.split(',') : []) as SourceCheckFailure[];
    const drafted = await this.recipes.draft(row, link, failures, userId, locale);
    if (!drafted) throw new BadRequestException(t('error.source.draftUnavailable'));
    return this.info(documentId);
  }

  async dismissRecipe(documentId: string, userId: string): Promise<DocumentSourceInfo> {
    const { row, link } = await this.require(documentId);
    await this.recipes.dismiss(row, link, userId);
    return this.info(documentId);
  }

  /** A fresh signing secret, shown once; the old one stops working. */
  async rotateWebhook(documentId: string): Promise<DocumentSourceWebhookResponse> {
    const { row } = await this.require(documentId);
    const secret = randomBytes(24).toString('hex');
    await this.connectors.update(row.id, { webhookSecret: secret });
    const base = this.config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    return { url: `${base}/v1/connectors/${row.id}/webhook`, secret, header: 'X-Hub-Signature-256' };
  }

  private async require(documentId: string): Promise<{ row: Connector; link: ConnectorLink }> {
    this.connectors.assertKindEnabled('web');
    const link = await this.prisma.connectorLink.findFirst({
      where: { documentId, connector: { kind: 'web' } },
      include: { connector: true },
    });
    if (!link) throw new NotFoundException(t('error.source.notFound', { id: documentId }));
    const { connector, ...rest } = link;
    return { row: connector, link: rest };
  }
}

function checkInterval(minutes: number | null): number | null {
  if (minutes === null) return null;
  if (!(SOURCE_INTERVALS_MIN as readonly number[]).includes(minutes)) {
    throw new BadRequestException(t('error.source.interval', { allowed: SOURCE_INTERVALS_MIN.join(', ') }));
  }
  return minutes;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    throw new BadRequestException(t('error.connector.urlInvalid'));
  }
}

function hostOf(row: Connector): string | null {
  const url = (row.config as Record<string, unknown> | null)?.url;
  try {
    return typeof url === 'string' ? new URL(url).host : null;
  } catch {
    return null;
  }
}
