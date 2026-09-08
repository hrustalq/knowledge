import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkflowProducer } from './workflow.producer.js';
import { WorkflowRunnerService } from './workflow-runner.service.js';
import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_NODE_STALE_MS } from './workflow.constants.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const BATCH = 20;

/**
 * Re-queues work a dead worker left behind (docs/features/17), mirroring
 * `OutboxSweeper` and `StaleSweeper`.
 *
 * This is the other half of what makes a run resumable: the xstate snapshot
 * remembers *where* a run was, and this puts the work back on the queue. Kill
 * the worker mid-run and within one sweep the run is moving again.
 */
@Injectable()
export class WorkflowSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: WorkflowProducer,
    private readonly runner: WorkflowRunnerService,
  ) {}

  onModuleInit(): void {
    // One sweep shortly after boot, because the most likely reason this process
    // just started is that the last one died holding claimed nodes.
    setTimeout(() => void this.sweep(), 20_000).unref();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - WORKFLOW_NODE_STALE_MS);

      // Nodes claimed by a worker that never came back. Returning them to
      // `pending` is safe because a step is only ever *read* before it writes.
      const stuck = await this.prisma.workflowRunNode.findMany({
        where: { status: 'running', updatedAt: { lt: cutoff }, attempt: { lt: WORKFLOW_MAX_ATTEMPTS } },
        select: { id: true, runId: true, attempt: true },
        take: BATCH,
      });
      for (const node of stuck) {
        await this.prisma.workflowRunNode.update({
          where: { id: node.id },
          data: { status: 'pending', attempt: { increment: 1 } },
        });
        // A fresh jobId: the kept failed job blocks reuse of the original.
        await this.producer.enqueueRetry(node.id, node.attempt + 1);
      }

      // Nodes that never got picked up at all — a lost enqueue, or an API
      // process that died between creating the row and reaching Redis.
      const orphaned = await this.prisma.workflowRunNode.findMany({
        where: {
          status: 'pending',
          createdAt: { lt: new Date(Date.now() - 60_000) },
          run: { status: { in: ['running', 'awaiting-review'] } },
        },
        select: { id: true, runId: true },
        take: BATCH,
      });
      for (const node of orphaned) await this.producer.enqueue(node.id);

      const runs = new Set([...stuck, ...orphaned].map((n) => n.runId));
      for (const runId of runs) await this.runner.reconcileRun(runId);

      if (stuck.length || orphaned.length) {
        this.logger.log(`Workflow sweep re-queued ${stuck.length} stalled and ${orphaned.length} orphaned node(s)`);
      }
    } catch (e) {
      this.logger.warn(`Workflow sweep failed (non-fatal): ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
