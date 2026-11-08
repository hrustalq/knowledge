import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { requeueStale, staleFailure } from '../common/requeue-stale.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkflowProducer } from './workflow.producer.js';
import { WorkflowRunnerService } from './workflow-runner.service.js';
import { WORKFLOW_MAX_ATTEMPTS } from './workflow.constants.js';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

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

  private readonly staleMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: WorkflowProducer,
    private readonly runner: WorkflowRunnerService,
    config: ConfigService<Env, true>,
  ) {
    this.staleMs = Number(config.get('WORKFLOW_NODE_STALE_MS', { infer: true }) ?? 15 * 60_000);
  }

  onModuleInit(): void {
    // One sweep shortly after boot, because the most likely reason this process
    // just started is that the last one died holding claimed nodes.
    setTimeout(() => void this.sweep(), 20_000).unref();
    this.timer = setInterval(() => void this.sweep(), Math.min(SWEEP_INTERVAL_MS, this.staleMs));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Nodes claimed by a worker that never came back. Returning them to
      // `pending` is safe because a step is only ever *read* before it writes.
      // One out of attempts fails, and `reconcileRun` below settles its run.
      const { requeued, failed } = await requeueStale({
        staleField: 'updatedAt',
        staleMs: this.staleMs,
        maxAttempts: WORKFLOW_MAX_ATTEMPTS,
        find: (where) =>
          this.prisma.workflowRunNode.findMany({ where, select: { id: true, runId: true, attempt: true }, take: BATCH }),
        attemptOf: (node) => node.attempt,
        requeue: (where) =>
          this.prisma.workflowRunNode.updateMany({ where, data: { status: 'pending', attempt: { increment: 1 } } }),
        fail: (where) =>
          this.prisma.workflowRunNode.updateMany({
            where,
            data: { status: 'failed', error: staleFailure(WORKFLOW_MAX_ATTEMPTS + 1) },
          }),
        // A fresh jobId: the kept failed job blocks reuse of the original.
        enqueue: (node) => this.producer.enqueueRetry(node.id, node.attempt + 1),
      });
      const stuck = [...requeued, ...failed];

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
        this.logger.log(
          `Workflow sweep re-queued ${requeued.length} stalled and ${orphaned.length} orphaned node(s), failed ${failed.length}`,
        );
      }
    } catch (e) {
      this.logger.warn(`Workflow sweep failed (non-fatal): ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
