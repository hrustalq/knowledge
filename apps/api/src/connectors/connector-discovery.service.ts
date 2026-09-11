import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Connector, type ConnectorRun, type ConnectorRunItem } from '@prisma/client';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ConnectorAdapter, ConnectorContext, ExternalRef } from './adapters/connector.types.js';

/** One entry of the persisted discovery frontier. */
interface FrontierEntry {
  /** The item row whose children are still unwalked. */
  itemId: string;
  externalId: string;
  title: string;
  depth: number;
}

export interface DiscoveryOutcome {
  /** Nothing left to walk. */
  done: boolean;
  discovered: number;
  truncated: boolean;
}

/**
 * Turns the far side's hierarchy into rows (docs/features/26).
 *
 * The old pull drained `adapter.list()` into an in-memory array and then worked
 * through it, which is why a run could not be paused, resumed, inspected or
 * reverted: the only record that a page had been seen was a local variable. Here
 * every page discovered becomes a `connector_run_items` row immediately, and the
 * set of branches still to walk is a column — so the walk survives a pause, a
 * crash, a deploy and the sync timeout.
 *
 * Breadth-first by branch rather than by layer: a branch is walked into as soon
 * as it is found, which is what makes the tree fill in visibly and lets a person
 * stop a run once they can see it is pulling the wrong subtree.
 */
@Injectable()
export class ConnectorDiscoveryService {
  private readonly logger = new Logger(ConnectorDiscoveryService.name);
  private readonly maxItems: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.maxItems = this.config.get('CONNECTOR_SYNC_MAX_ITEMS', { infer: true });
  }

  /**
   * Walk up to `budget` branches, then return so the caller can checkpoint.
   *
   * Returning rather than looping to completion is the whole pause mechanism:
   * the caller re-reads the run row between calls, and a run that was paused
   * simply never asks for the next batch.
   */
  async step(
    row: Connector,
    run: ConnectorRun,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    budget: number,
  ): Promise<DiscoveryOutcome> {
    const scope = Array.isArray(run.scope) ? (run.scope as unknown as string[]) : null;

    // A webhook already said exactly what changed. Listing a whole space to
    // find three pages would be absurd, so those arrive as flat roots and
    // `fetch` fills in the real title and version.
    if (scope) return this.seedScope(run, scope);

    // No tree support: the flat path, unchanged, just recorded as rows now.
    if (!adapter.children) return this.seedFlat(run, adapter, ctx);

    let frontier = this.readFrontier(run);
    let discovered = run.discovered;

    // First call: seed the roots.
    if (frontier === null) {
      ctx.debug('discovery: roots');
      const created = await this.walk(run, adapter, ctx, null, discovered);
      discovered += created.length;
      frontier = created.filter((i) => i.hasChildren).map(toFrontier);
      await this.saveFrontier(run.id, frontier, discovered);
      return { done: frontier.length === 0, discovered, truncated: discovered >= this.maxItems };
    }

    let walked = 0;
    while (frontier.length > 0 && walked < budget) {
      if (discovered >= this.maxItems) {
        ctx.debug('discovery: stopped at max', { max: this.maxItems });
        await this.saveFrontier(run.id, [], discovered);
        return { done: true, discovered, truncated: true };
      }

      const next = frontier.shift() as FrontierEntry;
      walked += 1;

      const parent: ExternalRef = { externalId: next.externalId, title: next.title };
      const created = await this.walk(run, adapter, ctx, { ...parent, itemId: next.itemId }, discovered, next.depth + 1);
      discovered += created.length;
      frontier.push(...created.filter((i) => i.hasChildren).map(toFrontier));

      // The branch is walked; it is no longer a promise of more.
      await this.prisma.connectorRunItem.update({
        where: { id: next.itemId },
        data: { hasChildren: created.length > 0 },
      });
    }

    await this.saveFrontier(run.id, frontier, discovered);
    return { done: frontier.length === 0, discovered, truncated: discovered >= this.maxItems };
  }

  // --- one level ---

  private async walk(
    run: ConnectorRun,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    parent: (ExternalRef & { itemId: string }) | null,
    already: number,
    depth = 0,
  ): Promise<ConnectorRunItem[]> {
    const created: ConnectorRunItem[] = [];
    let position = 0;

    for await (const ref of adapter.children!(ctx, parent)) {
      if (already + created.length >= this.maxItems) break;
      const item = await this.upsertItem(run, ref, parent?.itemId ?? null, depth, position);
      position += 1;
      if (item) created.push(item);
    }

    ctx.debug('discovery: level', {
      parent: parent?.externalId ?? 'root',
      depth,
      found: created.length,
    });
    return created;
  }

  /**
   * Create the row, or leave an existing one alone.
   *
   * `@@unique([runId, externalId])` is what makes this safe: a resumed walk that
   * re-yields a branch, or a cycle in somebody's page tree, produces no
   * duplicate and no error. A page that appears twice under different parents
   * keeps the first placement — arbitrary, but stable across re-runs, which
   * matters more than which parent wins.
   */
  private async upsertItem(
    run: ConnectorRun,
    ref: ExternalRef,
    parentItemId: string | null,
    depth: number,
    position: number,
  ): Promise<ConnectorRunItem | null> {
    try {
      return await this.prisma.connectorRunItem.create({
        data: {
          runId: run.id,
          parentItemId,
          externalId: ref.externalId,
          externalParentId: ref.parentExternalId ?? null,
          externalUrl: ref.url ?? null,
          externalVersion: ref.version ?? null,
          title: ref.title || ref.externalId,
          depth,
          position,
          hasChildren: ref.hasChildren ?? false,
          status: 'discovered',
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  // --- the non-tree paths ---

  /** Webhook or explicit scope: a flat set of roots, each fetched on its own. */
  private async seedScope(run: ConnectorRun, scope: string[]): Promise<DiscoveryOutcome> {
    let position = 0;
    for (const externalId of scope.slice(0, this.maxItems)) {
      await this.upsertItem(run, { externalId, title: externalId }, null, 0, position);
      position += 1;
    }
    const discovered = await this.prisma.connectorRunItem.count({ where: { runId: run.id } });
    await this.saveFrontier(run.id, [], discovered);
    return { done: true, discovered, truncated: false };
  }

  /** An adapter with no `children()`: the pre-feature flat enumeration. */
  private async seedFlat(
    run: ConnectorRun,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
  ): Promise<DiscoveryOutcome> {
    let position = 0;
    let truncated = false;
    for await (const ref of adapter.list(ctx)) {
      if (position >= this.maxItems) {
        truncated = true;
        break;
      }
      await this.upsertItem(run, ref, null, 0, position);
      position += 1;
    }
    await this.saveFrontier(run.id, [], position);
    return { done: true, discovered: position, truncated };
  }

  /**
   * Attach anything the walk never reached (docs/features/26).
   *
   * A recursive walk can miss a page whose parent the token cannot read, and a
   * silently missing page is precisely the failure this feature exists to stop.
   * One flat pass afterwards is cheap — refs only, no bodies — and anything new
   * it finds becomes a root, flagged so the review step can say why it is there.
   */
  async repairOrphans(run: ConnectorRun, adapter: ConnectorAdapter, ctx: ConnectorContext): Promise<number> {
    if (!adapter.children) return 0;

    const known = new Set(
      (await this.prisma.connectorRunItem.findMany({ where: { runId: run.id }, select: { externalId: true } })).map(
        (i) => i.externalId,
      ),
    );

    let added = 0;
    try {
      for await (const ref of adapter.list(ctx)) {
        if (known.has(ref.externalId)) continue;
        if (known.size + added >= this.maxItems) break;
        const item = await this.upsertItem(run, ref, null, 0, known.size + added);
        if (item) {
          await this.prisma.connectorRunItem.update({
            where: { id: item.id },
            data: { draft: { warnings: [t('connector.warning.orphan')], orphan: true } as Prisma.InputJsonValue },
          });
          added += 1;
        }
      }
    } catch (err) {
      // Repair is a safety net, not the job. A space that refuses a flat list
      // still imported its tree, and failing the run here would throw that away.
      this.logger.warn(`Orphan repair for run ${run.id} failed (non-fatal): ${(err as Error).message}`);
      return added;
    }

    ctx.debug('discovery: orphans attached', { added });
    return added;
  }

  // --- frontier persistence ---

  private readFrontier(run: ConnectorRun): FrontierEntry[] | null {
    const raw = run.cursor;
    if (raw === null || raw === undefined) return null;
    if (!Array.isArray(raw)) return [];
    return raw as unknown as FrontierEntry[];
  }

  private async saveFrontier(runId: string, frontier: FrontierEntry[], discovered: number): Promise<void> {
    await this.prisma.connectorRun.update({
      where: { id: runId },
      data: { cursor: frontier as unknown as Prisma.InputJsonValue, discovered },
    });
  }
}

function toFrontier(item: ConnectorRunItem): FrontierEntry {
  return { itemId: item.id, externalId: item.externalId, title: item.title, depth: item.depth };
}
