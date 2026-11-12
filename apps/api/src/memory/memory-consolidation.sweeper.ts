import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FeaturesService } from '../auth/features.service.js';
import { Ticker } from '../common/ticker.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryConsolidationService } from './memory-consolidation.service.js';

const TICK_MS = 60_000;

/**
 * Observations (#993), the background half: one consolidation call per bank
 * per tick, for every bank with facts waiting, on a fixed tick with
 * back-pressure. Worker-only. What may run is `MemoryConsolidationService`'s
 * to decide (model, bank switch, budget, cap); this only finds the banks.
 */
@Injectable()
export class MemoryConsolidationSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryConsolidationSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly prisma: PrismaService,
    private readonly features: FeaturesService,
    private readonly consolidation: MemoryConsolidationService,
  ) {}

  onModuleInit(): void {
    this.ticker.every(TICK_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  /** One tick. Returns the facts consolidated. */
  async sweep(now = Date.now()): Promise<number> {
    return this.ticker.exclusive(async () => {
      if (this.features.unavailable().includes('memory')) return 0;
      // ponytail: every bank with a backlog each tick, banks are few; page by bank id if a deployment holds thousands
      const banks = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT b.id FROM memory_banks b
          JOIN workspaces w ON w.id = b.workspace_id AND w.deleted_at IS NULL
         WHERE b.enable_observations IS DISTINCT FROM false
           AND EXISTS (SELECT 1 FROM memory_units u WHERE u.bank_id = b.id AND u.fact_type <> 'observation' AND u.consolidated_at IS NULL)`;
      let facts = 0;
      for (const { id } of banks) {
        const bank = await this.prisma.memoryBank.findUnique({ where: { id } });
        if (!bank || (await this.features.disabled(bank.workspaceId)).includes('memory')) continue;
        facts += (await this.consolidation.pass(bank, { maxBatches: 1, now })).facts;
      }
      if (facts) this.logger.log(`Memory: consolidated ${facts} facts`);
      return facts;
    }, 0);
  }
}
