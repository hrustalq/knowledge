import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkflowMaterializerService } from './workflow-materializer.service.js';
import { WorkflowRunnerService } from './workflow-runner.service.js';
import { stepById } from '@knowledge/workflow';
import type { WorkflowGraph } from '@knowledge/contracts';

const SWEEP_INTERVAL_MS = 5_000;
const BATCH = 10;

/**
 * Finishes nodes parked in `materializing` (docs/features/17).
 *
 * It exists because of a boundary the worker cannot cross: writing a draft into
 * the page tree needs `DocumentsService`, and `DocumentsModule` will not load in
 * the worker process (`MergeRequestsService` depends on `AccessService` from the
 * global auth module, which the worker has no reason to carry). So an
 * auto-approved step lands its node in `materializing` and this sweeper — which
 * runs in the API process, where documents can be written — picks it up.
 *
 * It doubles as the recovery path for the interactive route: if the request
 * that approved a draft dies between the status write and the document write,
 * the node is left in `materializing` and gets finished here rather than
 * stranding a run.
 *
 * Auto-approval is still an authenticated decision — an admin marked the step
 * auto-approve and a person started the run — so the page is attributed to the
 * run's creator.
 */
@Injectable()
export class WorkflowMaterializeSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowMaterializeSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly materializer: WorkflowMaterializerService,
    private readonly runner: WorkflowRunnerService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return; // a slow sweep must not stack on itself
    this.running = true;
    try {
      const nodes = await this.prisma.workflowRunNode.findMany({
        where: { status: 'materializing', documentId: null },
        orderBy: { updatedAt: 'asc' },
        take: BATCH,
        include: { run: true },
      });

      for (const node of nodes) {
        // Guarded claim, so two sweepers running at once cannot both create the
        // page. The predicate has to include something this write CHANGES:
        // matching on `status` and writing `status` back left the row inside its
        // own predicate, so every caller got count === 1 and the guard passed for
        // all of them. `updatedAt` is the optimistic-lock column — the winner
        // bumps it, and the losers' `where` no longer matches.
        //
        // The claim stays OUTSIDE the boundary below: it is the anti-stacking
        // guard between two sweepers, and it only works because it commits
        // immediately and becomes visible. Inside, it would be invisible until
        // the page was already written.
        const claimed = await this.prisma.workflowRunNode.updateMany({
          where: {
            id: node.id,
            status: 'materializing',
            documentId: null,
            updatedAt: node.updatedAt,
          },
          data: { updatedAt: new Date() },
        });
        if (claimed.count !== 1) continue;

        const graph = node.run.definitionSnapshot as unknown as WorkflowGraph;
        const step = stepById(graph, node.stepId);
        if (!step) {
          await this.runner.failNode(node.id, `Step "${node.stepId}" is no longer part of this run`);
          await this.runner.reconcileRun(node.runId);
          continue;
        }

        try {
          // The page, the `documentId` back-reference and the children commit
          // together. Previously `materialize()` committed its own document and
          // the node update followed unprotected, so a crash in between left
          // the node still `materializing` with `documentId: null` — matching
          // this very sweeper's predicate, which then created a second page.
          await this.prisma.withTransaction(
            async () => {
              const documentId = await this.materializer.materialize(
                node,
                node.run,
                step,
                node.run.createdBy,
              );
              const updated = await this.prisma.workflowRunNode.update({
                where: { id: node.id },
                data: { status: 'materialized', documentId },
              });
              await this.runner.spawnChildren(node.run, updated, step);
            },
            { timeout: 30_000, maxWait: 10_000 },
          );
        } catch (e) {
          // Outside the boundary: the failure record must survive the rollback.
          const message = (e as Error).message;
          this.logger.warn(`Materialising node ${node.id} failed: ${message}`);
          await this.runner.failNode(node.id, message);
        }
        await this.runner.reconcileRun(node.runId);
      }
    } catch (e) {
      this.logger.warn(`Materialise sweep failed (non-fatal): ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
