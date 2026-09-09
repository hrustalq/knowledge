import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { Prisma, type Connector, type ConnectorLink, type ConnectorRun } from '@prisma/client';
import type { DocumentCategory } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ConnectorsService, MAX_WARNINGS } from './connectors.service.js';
import type { ConnectorAdapter, ConnectorContext, ExternalDocument, ExternalRef } from './adapters/connector.types.js';

/** Stage writes are throttled the way ImportProcessor throttles its own. */
const STAGE_THROTTLE_MS = 400;

interface RunTotals {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  conflicts: number;
}

/**
 * The sync engine (docs/features/19).
 *
 * Everything here is driven by one idea: `connector_links` records the content
 * hash and external version the two sides last agreed on, so both directions
 * can ask "did anything actually change?" before writing. That is what makes a
 * re-sync idempotent, and it is what breaks the pull -> push -> webhook -> pull
 * echo loop, because a pull leaves the link agreeing with what it just wrote.
 */
@Injectable()
export class ConnectorSyncService {
  private readonly logger = new Logger(ConnectorSyncService.name);
  private readonly maxItems: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly connectors: ConnectorsService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageService,
    private readonly events: EventsPublisher,
  ) {
    this.maxItems = this.config.get('CONNECTOR_SYNC_MAX_ITEMS', { infer: true });
  }

  async run(row: Connector, runRow: ConnectorRun, signal?: AbortSignal): Promise<void> {
    const adapter = this.connectors.adapterFor(row);
    const warnings: Array<{ externalId: string | null; title: string | null; message: string }> = [];
    const totals: RunTotals = { created: 0, updated: 0, skipped: 0, failed: 0, conflicts: 0 };

    let lastStageWrite = 0;
    const onStage = async (stage: string, progress?: number | null): Promise<void> => {
      const now = Date.now();
      if (now - lastStageWrite < STAGE_THROTTLE_MS) return;
      lastStageWrite = now;
      await this.prisma.connectorRun
        .update({ where: { id: runRow.id }, data: { stage, progress: progress ?? null } })
        .catch(() => undefined);
    };

    const ctx = await this.connectors.contextFor(row, onStage, signal);
    const scope = Array.isArray(runRow.scope) ? (runRow.scope as unknown as string[]) : null;

    await onStage(t('connector.stage.connecting'), null);

    if (runRow.direction === 'pull') {
      await this.pull(row, adapter, ctx, scope, totals, warnings);
    } else {
      await this.push(row, adapter, ctx, scope, totals, warnings);
    }

    await onStage(t('connector.stage.finishing'), 1);
    lastStageWrite = 0;

    const status = totals.failed > 0 ? 'partial' : 'succeeded';
    await this.prisma.connectorRun.update({
      where: { id: runRow.id },
      data: {
        status,
        stage: null,
        progress: 1,
        ...totals,
        warnings: warnings.slice(0, MAX_WARNINGS) as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    await this.prisma.connector.update({
      where: { id: row.id },
      data: { lastRunId: runRow.id, lastSyncedAt: new Date() },
    });
    await this.events.publish({
      workspaceId: row.workspaceId,
      type: totals.failed > 0 ? 'connector.run.failed' : 'connector.run.succeeded',
      subjectId: row.id,
      title: row.name,
    });
  }

  // --- pull ---

  private async pull(
    row: Connector,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    scope: string[] | null,
    totals: RunTotals,
    warnings: Array<{ externalId: string | null; title: string | null; message: string }>,
  ): Promise<void> {
    await ctx.onStage(t('connector.stage.listing'), null);

    const refs: ExternalRef[] = [];
    if (scope) {
      // A webhook already told us what changed; listing the whole space to find
      // three pages would be absurd, so the refs are synthesised and `fetch`
      // fills in the real title and version.
      refs.push(...scope.map((externalId) => ({ externalId, title: externalId })));
    } else {
      for await (const ref of adapter.list(ctx)) {
        refs.push(ref);
        if (refs.length >= this.maxItems) {
          warnings.push({
            externalId: null,
            title: null,
            message: `Stopped after ${this.maxItems} items (CONNECTOR_SYNC_MAX_ITEMS).`,
          });
          break;
        }
      }
    }

    const links = await this.linksByExternalId(row.id);
    let done = 0;

    for (const ref of refs) {
      done += 1;
      const progress = refs.length ? done / refs.length : null;
      const link = links.get(ref.externalId);

      try {
        // Cheapest possible skip: the far side says nothing changed.
        if (link && ref.version && link.externalVersion === ref.version) {
          totals.skipped += 1;
          continue;
        }

        await ctx.onStage(t('connector.stage.fetching', { title: ref.title || ref.externalId }), progress);
        const doc = await adapter.fetch(ctx, ref);
        for (const message of doc.warnings) {
          warnings.push({ externalId: ref.externalId, title: doc.title, message });
        }

        const markdown = composeMarkdown(doc);
        const hash = sha256(markdown);

        // The far side changed but produced identical content (a Confluence
        // version bump from a label edit, say). Record the version and move on.
        if (link && link.contentHash === hash) {
          await this.prisma.connectorLink.update({
            where: { id: link.id },
            data: { externalVersion: doc.ref.version ?? null, lastPulledAt: new Date() },
          });
          totals.skipped += 1;
          continue;
        }

        await ctx.onStage(t('connector.stage.writing', { title: doc.title }), progress);

        if (!link) {
          await this.createPage(row, doc, markdown, hash);
          totals.created += 1;
          continue;
        }

        const document = await this.prisma.document.findUnique({ where: { id: link.documentId } });
        if (!document) {
          // The page was deleted here. The link is stale; drop it and let the
          // next run re-create the page from scratch.
          await this.prisma.connectorLink.delete({ where: { id: link.id } });
          warnings.push({
            externalId: ref.externalId,
            title: doc.title,
            message: t('connector.warning.documentMissing'),
          });
          totals.skipped += 1;
          continue;
        }

        const localHash = await this.headContentHash(link.documentId);
        const localChanged = localHash !== null && link.contentHash !== null && localHash !== link.contentHash;

        if (!localChanged || row.conflict === 'external-wins') {
          await this.writeRevision(link.documentId, markdown);
          await this.prisma.connectorLink.update({
            where: { id: link.id },
            data: {
              contentHash: hash,
              externalVersion: doc.ref.version ?? null,
              externalTitle: doc.title,
              externalUrl: doc.ref.url ?? link.externalUrl,
              lastPulledAt: new Date(),
            },
          });
          totals.updated += 1;
        } else if (row.conflict === 'local-wins') {
          // Ours stands; record that we have seen this external version so the
          // same conflict is not re-detected on every subsequent run.
          await this.prisma.connectorLink.update({
            where: { id: link.id },
            data: { externalVersion: doc.ref.version ?? null, lastPulledAt: new Date() },
          });
          totals.skipped += 1;
        } else {
          await this.openConflictBranch(row, link, doc, markdown);
          totals.conflicts += 1;
          warnings.push({
            externalId: ref.externalId,
            title: doc.title,
            message: t('connector.warning.conflict'),
          });
        }
      } catch (err) {
        totals.failed += 1;
        warnings.push({
          externalId: ref.externalId,
          title: ref.title || null,
          message: (err as Error).message.slice(0, 500),
        });
        this.logger.warn(`connector ${row.id}: ${ref.externalId} failed — ${(err as Error).message}`);
      }
    }
  }

  // --- push ---

  private async push(
    row: Connector,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    scope: string[] | null,
    totals: RunTotals,
    warnings: Array<{ externalId: string | null; title: string | null; message: string }>,
  ): Promise<void> {
    if (!adapter.push) {
      warnings.push({ externalId: null, title: null, message: t('connector.warning.pushUnsupported', { kind: row.kind }) });
      return;
    }

    const links = await this.prisma.connectorLink.findMany({
      where: {
        connectorId: row.id,
        ...(scope?.length ? { OR: [{ externalId: { in: scope } }, { documentId: { in: scope } }] } : {}),
      },
      take: this.maxItems,
    });

    let done = 0;
    for (const link of links) {
      done += 1;
      const progress = links.length ? done / links.length : null;
      try {
        const document = await this.prisma.document.findUnique({ where: { id: link.documentId } });
        if (!document) {
          await this.prisma.connectorLink.delete({ where: { id: link.id } });
          warnings.push({
            externalId: link.externalId,
            title: link.externalTitle,
            message: t('connector.warning.documentMissing'),
          });
          totals.skipped += 1;
          continue;
        }

        const content = await this.documents.getContent(link.documentId);
        const hash = sha256(content.markdown);

        // Nothing of ours changed since the last agreement — this is the half of
        // the loop guard that stops a pull's own revision bouncing straight back.
        if (link.contentHash === hash) {
          totals.skipped += 1;
          continue;
        }

        await ctx.onStage(t('connector.stage.pushing', { title: document.title }), progress);
        const ref = await adapter.push(ctx, {
          documentId: link.documentId,
          title: document.title,
          markdown: content.markdown,
          ref: {
            externalId: link.externalId,
            title: link.externalTitle ?? document.title,
            url: link.externalUrl ?? undefined,
            version: link.externalVersion ?? undefined,
          },
        });

        await this.prisma.connectorLink.update({
          where: { id: link.id },
          data: {
            contentHash: hash,
            revisionId: content.revisionId,
            externalVersion: ref.version ?? null,
            externalUrl: ref.url ?? link.externalUrl,
            externalTitle: document.title,
            lastPushedAt: new Date(),
          },
        });
        totals.updated += 1;
      } catch (err) {
        totals.failed += 1;
        warnings.push({
          externalId: link.externalId,
          title: link.externalTitle,
          message: (err as Error).message.slice(0, 500),
        });
      }
    }
  }

  // --- document writes ---

  private async createPage(
    row: Connector,
    doc: ExternalDocument,
    markdown: string,
    hash: string,
  ): Promise<void> {
    // Created without inline content and written once afterwards, the way
    // import's submit does: one revision whose content was never half-written.
    const created = await this.documents.createDocument({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      title: doc.title || 'Untitled',
      category: row.category as DocumentCategory,
      ...(row.parentId ? { parentId: row.parentId } : {}),
    });

    const revision = await this.prisma.documentRevision.findUnique({ where: { id: created.revisionId } });
    if (!revision) throw new Error('revision vanished between create and write');
    await this.storage.putObjectText(revision.s3Key, markdown, 'text/markdown');
    await this.documents.finalizeRevision(created.documentId, created.revisionId);

    await this.prisma.connectorLink.create({
      data: {
        connectorId: row.id,
        workspaceId: row.workspaceId,
        documentId: created.documentId,
        externalId: doc.ref.externalId,
        externalUrl: doc.ref.url ?? null,
        externalTitle: doc.title,
        externalVersion: doc.ref.version ?? null,
        contentHash: hash,
        revisionId: created.revisionId,
        lastPulledAt: new Date(),
      },
    });
    await this.events.publish({
      workspaceId: row.workspaceId,
      type: 'connector.link.created',
      documentId: created.documentId,
      subjectId: row.id,
      title: doc.title,
    });
  }

  /** A new revision on the document's default branch, through the normal pipeline. */
  private async writeRevision(documentId: string, markdown: string, branch?: string): Promise<string> {
    const revision = await this.documents.createRevision(documentId, {
      branch,
      message: 'Synced from a connector',
      contentType: 'text/markdown',
    });
    const row = await this.prisma.documentRevision.findUnique({ where: { id: revision.revisionId } });
    if (!row) throw new Error('revision vanished between create and write');
    await this.storage.putObjectText(row.s3Key, markdown, 'text/markdown');
    await this.documents.finalizeRevision(documentId, revision.revisionId);
    return revision.revisionId;
  }

  /**
   * Both sides changed. Nothing is overwritten: the external version goes onto
   * its own branch and the conflict is recorded for the API-side sweeper to
   * open a merge request from. Phase 3 already renders structural and semantic
   * diffs over exactly this shape, so two-way conflict resolution costs a
   * branch rather than a new UI.
   */
  private async openConflictBranch(
    row: Connector,
    link: ConnectorLink,
    doc: ExternalDocument,
    markdown: string,
  ): Promise<void> {
    const branch = `connector/${row.kind}-${Date.now().toString(36)}`;
    await this.documents.createBranch(link.documentId, { name: branch });
    const revisionId = await this.writeRevision(link.documentId, markdown, branch);

    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: {
        // The external version is recorded so the same conflict is not raised
        // again on every run, but contentHash deliberately is not: the two sides
        // have not agreed on anything yet.
        externalVersion: doc.ref.version ?? null,
        externalTitle: doc.title,
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
        externalUrl: doc.ref.url ?? null,
        title: doc.title,
      },
    });
  }

  // --- helpers ---

  private async linksByExternalId(connectorId: string): Promise<Map<string, ConnectorLink>> {
    const rows = await this.prisma.connectorLink.findMany({ where: { connectorId } });
    return new Map(rows.map((row) => [row.externalId, row]));
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

/** Frontmatter is re-attached so the deterministic relation extractor sees it. */
export function composeMarkdown(doc: ExternalDocument): string {
  const data = doc.frontmatter ?? {};
  const body = doc.markdown.trim();
  return Object.keys(data).length > 0 ? matter.stringify(body, data) : body;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
