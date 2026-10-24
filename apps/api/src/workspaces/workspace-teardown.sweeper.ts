import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkspaceTeardownService } from './workspace-teardown.service.js';

/** A deletion is kicked at once by the request; the tick is its crash recovery. */
export const WORKSPACE_TEARDOWN_INTERVAL_MS = 60_000;

/**
 * Finishes every tombstoned workspace (#479) on one fixed tick with
 * back-pressure (CLAUDE.md: no cron in this repo). API-side: the teardown
 * needs storage, the graph and BM25. A pass that fails or is interrupted
 * leaves the tombstone, so the next tick resumes it.
 */
@Injectable()
export class WorkspaceTeardownSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceTeardownSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly teardown: WorkspaceTeardownService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), WORKSPACE_TEARDOWN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Workspaces removed this pass. A pass already running makes this one a no-op; the next tick catches up. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.prisma.workspace.findMany({
        where: { deletedAt: { not: null } },
        orderBy: { deletedAt: 'asc' },
        select: { id: true },
      });
      let removed = 0;
      for (const { id } of due) {
        const done = await this.teardown.teardown(id).catch((e: unknown) => {
          this.logger.warn(`workspace ${id}: teardown interrupted, resuming next tick: ${String(e)}`);
          return false;
        });
        if (done) removed++;
      }
      if (removed > 0) this.logger.log(`removed ${removed} deleted workspace(s)`);
      return removed;
    } catch (e) {
      this.logger.warn(`workspace teardown sweep failed: ${String(e)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
