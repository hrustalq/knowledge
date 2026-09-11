import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Connector, type ConnectorLink, type ConnectorRun } from '@prisma/client';
import type { ConnectorRunPhase } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConnectorsService, MAX_WARNINGS } from './connectors.service.js';
import { ConnectorDiscoveryService } from './connector-discovery.service.js';
import { sha256 } from './connector-markdown.js';
import { ConnectorStagingService } from './connector-staging.service.js';
import type { ConnectorAdapter, ConnectorContext } from './adapters/connector.types.js';

/** Stage writes are throttled the way ImportProcessor throttles its own. */
const STAGE_THROTTLE_MS = 400;

export interface RunTotals {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  conflicts: number;
  applied: number;
}

export interface RunWarning {
  externalId: string | null;
  title: string | null;
  message: string;
}

/** What the processor does next: ask for another slice, or stop. */
export interface RunStep {
  done: boolean;
}

/**
 * The sync engine (docs/features/19, reshaped by 26).
 *
 * Everything here is driven by one idea: `connector_links` records the content
 * hash and external version the two sides last agreed on, so both directions
 * can ask "did anything actually change?" before writing. That is what makes a
 * re-sync idempotent, and it is what breaks the pull -> push -> webhook -> pull
 * echo loop, because a pull leaves the link agreeing with what it just wrote.
 *
 * Feature 26 turned the pull inside out. It used to drain the whole scope into
 * an array and write pages as it went; now discovery, staging and applying are
 * separate budgeted phases over `connector_run_items` rows, so the work can be
 * watched, paused, reviewed and undone. Push is untouched — there is nothing to
 * stage on the way out.
 */
@Injectable()
export class ConnectorSyncService {
  private readonly logger = new Logger(ConnectorSyncService.name);
  private readonly maxItems: number;
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly connectors: ConnectorsService,
    private readonly discovery: ConnectorDiscoveryService,
    private readonly staging: ConnectorStagingService,
    // Push still reads page content directly; the pull path goes through the
    // staging service instead.
    private readonly documents: DocumentsService,
    private readonly events: EventsPublisher,
  ) {
    this.maxItems = this.config.get('CONNECTOR_SYNC_MAX_ITEMS', { infer: true });
    this.batchSize = this.config.get('CONNECTOR_SYNC_BATCH', { infer: true });
  }

  /** Links for this connector, keyed the way the staging loop looks them up. */
  private async linksByExternalId(connectorId: string): Promise<Map<string, ConnectorLink>> {
    const links = await this.prisma.connectorLink.findMany({ where: { connectorId } });
    return new Map(links.map((l) => [l.externalId, l]));
  }

  /**
   * One slice of a run's work, then return (docs/features/26).
   *
   * `RunStep.continue` means "there is more, enqueue me again" — the processor
   * re-enqueues rather than looping here, so a large space cannot die on
   * `CONNECTOR_SYNC_TIMEOUT_MS` and a pause is noticed within one batch instead
   * of at the end of a thousand pages.
   */
  async run(row: Connector, runRow: ConnectorRun, signal?: AbortSignal): Promise<RunStep> {
    const warnings = readWarnings(runRow);
    const totals: RunTotals = {
      created: runRow.created,
      updated: runRow.updated,
      skipped: runRow.skipped,
      failed: runRow.failed,
      conflicts: runRow.conflicts,
      applied: runRow.applied,
    };

    let lastStageWrite = 0;
    const onStage = async (stage: string, progress?: number | null): Promise<void> => {
      const now = Date.now();
      if (now - lastStageWrite < STAGE_THROTTLE_MS) return;
      lastStageWrite = now;
      await this.prisma.connectorRun
        .update({ where: { id: runRow.id }, data: { stage, progress: progress ?? null } })
        .catch(() => undefined);
    };

    const adapter = this.connectors.adapterFor(row);
    const ctx = await this.connectors.contextFor(row, onStage, signal);

    // Push has nothing to stage or review; it keeps the pre-feature shape whole.
    if (runRow.direction === 'push') {
      const scope = Array.isArray(runRow.scope) ? (runRow.scope as unknown as string[]) : null;
      await onStage(t('connector.stage.connecting'), null);
      await this.push(row, adapter, ctx, scope, totals, warnings);
      await this.finish(row, runRow, totals, warnings);
      return { done: true };
    }

    return this.pullStep(row, runRow, adapter, ctx, onStage, totals, warnings);
  }

  /**
   * Discover → stage → (park for review) → apply, one budgeted slice at a time.
   *
   * The phases are checked in order on every call rather than held in a local
   * variable, because the run row is the only thing that survives between
   * slices — the same reason the item tree is rows and not a snapshot.
   */
  private async pullStep(
    row: Connector,
    runRow: ConnectorRun,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    onStage: (stage: string, progress?: number | null) => Promise<void>,
    totals: RunTotals,
    warnings: RunWarning[],
  ): Promise<RunStep> {
    const budget = this.batchSize;

    // --- discovery ---
    if (runRow.phase === null || runRow.phase === 'discovering') {
      await this.setPhase(runRow.id, 'discovering');
      await onStage(t('connector.stage.listing'), null);

      const outcome = await this.discovery.step(row, runRow, adapter, ctx, budget);
      if (outcome.truncated) {
        pushWarning(warnings, null, null, t('connector.stoppedAtMax', { max: this.maxItems }));
      }
      if (!outcome.done) {
        await this.checkpoint(runRow.id, totals, warnings);
        return { done: false };
      }

      const orphans = await this.discovery.repairOrphans(runRow, adapter, ctx);
      if (orphans > 0) pushWarning(warnings, null, null, t('connector.warning.orphansFound', { count: orphans }));

      await this.setPhase(runRow.id, 'fetching');
      await this.checkpoint(runRow.id, totals, warnings);
      return { done: false };
    }

    // --- staging ---
    if (runRow.phase === 'fetching') {
      // `step` mode releases exactly one page at a time, which is what makes a
      // misbehaving space debuggable without pulling all of it.
      const take = runRow.mode === 'step' ? 1 : budget;
      const pending = await this.prisma.connectorRunItem.findMany({
        where: { runId: runRow.id, status: 'discovered' },
        orderBy: [{ depth: 'asc' }, { position: 'asc' }],
        take,
      });

      if (pending.length > 0) {
        const links = await this.linksByExternalId(row.id);
        const total = Math.max(runRow.discovered, 1);

        for (const item of pending) {
          const claimed = await this.prisma.connectorRunItem.updateMany({
            where: { id: item.id, status: 'discovered' },
            data: { status: 'fetching' },
          });
          if (claimed.count !== 1) continue;

          const done = await this.prisma.connectorRunItem.count({
            where: { runId: runRow.id, status: { notIn: ['discovered', 'fetching'] } },
          });
          await onStage(t('connector.stage.fetching', { title: item.title }), done / total);

          try {
            const outcome = await this.staging.stage(row, runRow, adapter, ctx, item, links.get(item.externalId) ?? null);
            if (outcome.unchanged) totals.skipped += 1;
          } catch (err) {
            totals.failed += 1;
            pushWarning(warnings, item.externalId, item.title, (err as Error).message.slice(0, 500));
            await this.failItem(item.id, (err as Error).message);
            ctx.debug('item: failed', { id: item.externalId, error: (err as Error).message });
          }
        }

        await this.checkpoint(runRow.id, totals, warnings);
        // A stepping run hands control back after each page.
        if (runRow.mode === 'step') return this.parkForReview(row, runRow, totals, warnings);
        return { done: false };
      }

      // Everything fetched. An unattended run applies; anything else waits.
      if (runRow.mode === 'auto') {
        await this.prisma.connectorRunItem.updateMany({
          where: { runId: runRow.id, status: 'staged' },
          data: { status: 'approved' },
        });
        await this.setPhase(runRow.id, 'applying');
        await this.checkpoint(runRow.id, totals, warnings);
        return { done: false };
      }
      return this.parkForReview(row, runRow, totals, warnings);
    }

    // --- applying ---
    if (runRow.phase === 'applying') {
      const approved = await this.prisma.connectorRunItem.findMany({
        where: { runId: runRow.id, status: 'approved' },
        // Parents first: a child needs its parent's document id to nest under.
        orderBy: [{ depth: 'asc' }, { position: 'asc' }],
        take: budget,
      });

      if (approved.length > 0) {
        for (const item of approved) {
          const claimed = await this.prisma.connectorRunItem.updateMany({
            where: { id: item.id, status: 'approved' },
            data: { status: 'applying' },
          });
          if (claimed.count !== 1) continue;

          await onStage(t('connector.stage.writing', { title: item.title }), null);
          try {
            await this.staging.apply(row, runRow, item);
            if (item.action === 'create') totals.created += 1;
            else if (item.action === 'conflict') totals.conflicts += 1;
            else if (item.action === 'update') totals.updated += 1;
            if (item.action !== 'unchanged') totals.applied += 1;
          } catch (err) {
            totals.failed += 1;
            pushWarning(warnings, item.externalId, item.title, (err as Error).message.slice(0, 500));
            await this.failItem(item.id, (err as Error).message);
            ctx.debug('item: apply failed', { id: item.externalId, error: (err as Error).message });
          }
        }

        await this.checkpoint(runRow.id, totals, warnings);
        return { done: false };
      }

      // Nothing approved is left. A reviewed run may still hold staged items a
      // person has not decided on, so it goes back to waiting rather than ending.
      const staged = await this.prisma.connectorRunItem.count({
        where: { runId: runRow.id, status: 'staged' },
      });
      if (staged > 0 && runRow.mode !== 'auto') return this.parkForReview(row, runRow, totals, warnings);

      await this.finish(row, runRow, totals, warnings);
      return { done: true };
    }

    // 'awaiting-review' / 'reverting' are not the worker's to advance.
    return { done: true };
  }

  /** Hand the run to a person and stop asking for slices. */
  private async parkForReview(
    row: Connector,
    runRow: ConnectorRun,
    totals: RunTotals,
    warnings: RunWarning[],
  ): Promise<RunStep> {
    await this.prisma.connectorRun.update({
      where: { id: runRow.id },
      data: {
        status: 'awaiting-review',
        phase: 'awaiting-review',
        stage: null,
        ...totals,
        warnings: warnings.slice(0, MAX_WARNINGS) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.events.publish({
      workspaceId: row.workspaceId,
      type: 'connector.run.awaiting-review',
      subjectId: runRow.id,
      title: row.name,
    });
    return { done: true };
  }

  /**
   * Write what is known so far.
   *
   * Counters used to be written once at the very end, which meant a run that hit
   * the timeout lost every count and every warning it had gathered — the run
   * that most needed to explain itself was the one that said nothing.
   */
  private async checkpoint(runId: string, totals: RunTotals, warnings: RunWarning[]): Promise<void> {
    await this.prisma.connectorRun.update({
      where: { id: runId },
      data: { ...totals, warnings: warnings.slice(0, MAX_WARNINGS) as unknown as Prisma.InputJsonValue },
    });
  }

  private async setPhase(runId: string, phase: ConnectorRunPhase): Promise<void> {
    await this.prisma.connectorRun.update({ where: { id: runId }, data: { phase } });
  }

  private async failItem(itemId: string, message: string): Promise<void> {
    await this.prisma.connectorRunItem
      .update({ where: { id: itemId }, data: { status: 'failed', error: message.slice(0, 1000) } })
      .catch(() => undefined);
  }

  /** Terminal bookkeeping, shared by the pull and push paths. */
  async finish(row: Connector, runRow: ConnectorRun, totals: RunTotals, warnings: RunWarning[]): Promise<void> {
    const status = totals.failed > 0 ? 'partial' : 'succeeded';
    await this.prisma.connectorRun.update({
      where: { id: runRow.id },
      data: {
        status,
        phase: null,
        stage: null,
        progress: 1,
        cursor: Prisma.DbNull,
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
}

/**
 * Warnings now survive between slices, so they are read back off the row rather
 * than starting empty — a run that reports only what its last batch noticed is
 * worse than one that reports nothing, because it looks complete.
 */
function readWarnings(run: ConnectorRun): RunWarning[] {
  return Array.isArray(run.warnings) ? (run.warnings as unknown as RunWarning[]) : [];
}

function pushWarning(warnings: RunWarning[], externalId: string | null, title: string | null, message: string): void {
  if (warnings.length >= MAX_WARNINGS) return;
  warnings.push({ externalId, title, message });
}
