import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Ticker } from '../common/ticker.js';
import { GraphService } from '../graph/graph.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const TICK_MS = 10 * 60_000;
/** A vector younger than this may belong to a retain still committing, so the reap leaves it. */
const REAP_GRACE_MS = 5 * 60_000;
const REAP_PAGE = 1000;

/**
 * Memory vectors whose row is gone (#986): a retain that crashed between the
 * vector and the row, a delete whose vector call failed, a bank or a workspace
 * removed. PG is the truth and recall joins the row, so an orphan is never
 * returned; this only keeps the index from growing. Worker-only, a fixed tick
 * with back-pressure, as chat search's reap is.
 */
@Injectable()
export class MemoryReapSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryReapSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
  ) {}

  onModuleInit(): void {
    this.ticker.every(TICK_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  /** One tick. Returns the vectors removed. */
  async sweep(now = Date.now()): Promise<number> {
    return this.ticker.exclusive(async () => {
      // Every workspace, not only those with a bank: a deleted bank's vectors have no bank row left to find them by.
      const workspaces = await this.prisma.workspace.findMany({ select: { id: true } });
      let reaped = 0;
      for (const { id: workspaceId } of workspaces) {
        // ponytail: reads every vector id of the workspace each tick; page it by writtenAt if a bank grows past ~100k memories
        const vectors = (await this.graph.memoryUnitIds(workspaceId)).filter((v) => now - v.writtenAt > REAP_GRACE_MS).map((v) => v.unitId);
        for (let i = 0; i < vectors.length; i += REAP_PAGE) {
          const page = vectors.slice(i, i + REAP_PAGE);
          const kept = new Set((await this.prisma.memoryUnit.findMany({ where: { id: { in: page } }, select: { id: true } })).map((r) => r.id));
          const orphans = page.filter((id) => !kept.has(id));
          await this.graph.deleteMemoryUnits(workspaceId, orphans);
          reaped += orphans.length;
        }
      }
      if (reaped) this.logger.log(`Memory: reaped ${reaped} orphaned vectors`);
      return reaped;
    }, 0);
  }
}
