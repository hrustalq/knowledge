import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Ticker } from '../common/ticker.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryFilesService } from './memory-files.service.js';

const TICK_MS = 60_000;
/** A file written this recently is still being indexed by its own write, so the sweep leaves it. */
const INDEX_GRACE_MS = 30_000;
const SWEEP_PAGE = 20;
const MAX_FAILURES = 3;

/**
 * The memory tool's files whose recall chunks are behind their text (#1009):
 * an index that failed after the write (no embedding provider, a store not
 * ready), a writer that gave up after `INDEX_ATTEMPTS`, a rename (the moved
 * chunks keep vectors embedded with the old path) or a row never indexed.
 * Stale = `indexed_at` is not the row's `updated_at`; `reindex` sets it.
 *
 * API-only, beside `MemoryFilesService`, on a fixed tick with back-pressure.
 * `MAX_FAILURES` ends a tick: that many is the provider or the store, and the
 * next file would fail the same way; fewer may be one file, which must not
 * hold up the rest.
 */
@Injectable()
export class MemoryFilesIndexSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryFilesIndexSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: MemoryFilesService,
  ) {}

  onModuleInit(): void {
    this.ticker.every(TICK_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  /** One tick. Returns the files brought level. */
  async sweep(now = Date.now()): Promise<number> {
    return this.ticker.exclusive(async () => {
      // ponytail: scans memory_files each tick; add a partial index on (updated_at) WHERE indexed_at IS DISTINCT FROM updated_at if banks grow past ~100k files
      const stale = await this.prisma.$queryRaw<Array<{ id: string; bank_id: string }>>`
        SELECT f.id, f.bank_id FROM memory_files f
          JOIN workspaces w ON w.id = f.workspace_id AND w.deleted_at IS NULL
         WHERE f.indexed_at IS DISTINCT FROM f.updated_at AND f.updated_at < ${new Date(now - INDEX_GRACE_MS)}
         ORDER BY f.updated_at
         LIMIT ${SWEEP_PAGE}`;
      const banks = new Map((await this.prisma.memoryBank.findMany({ where: { id: { in: [...new Set(stale.map((f) => f.bank_id))] } } })).map((b) => [b.id, b]));
      let done = 0;
      let failed = 0;
      for (const { id, bank_id } of stale) {
        const bank = banks.get(bank_id);
        if (!bank) continue;
        if (await this.files.reindex(bank, id)) done++;
        else if (++failed >= MAX_FAILURES) break;
      }
      if (done) this.logger.log(`Memory files: ${done} recall indexes rewritten`);
      return done;
    }, 0);
  }
}
