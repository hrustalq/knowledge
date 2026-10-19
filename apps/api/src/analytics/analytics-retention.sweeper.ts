import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

const TICK_MS = 60 * 60 * 1000;
const BATCH = 5000;
/** Batches per table per tick: a backlog drains over several hours rather than one long lock. */
const MAX_BATCHES = 20;
/** The event tables; a closed list, so interpolating the name is safe. */
const TABLES = ['page_views', 'search_queries', 'mcp_tool_calls'] as const;

/**
 * Retention for the analytics event rows (#79), worker-only. Once an hour it
 * deletes rows older than each workspace's effective retention and nulls the
 * text of searches older than ANALYTICS_QUERY_TEXT_DAYS — the hash stays, so
 * a query still groups after its words are gone. It creates and attributes
 * nothing, so there is no API-side half.
 *
 * The clamp is `effectiveAnalytics` spelled in SQL: a workspace's own days,
 * never past ANALYTICS_RETENTION_DAYS. Rows with no workspace (an MCP call
 * that named none) take the ceiling.
 */
@Injectable()
export class AnalyticsRetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsRetentionSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), TICK_MS);
    this.timer.unref();
    void this.sweep();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    // Back-pressure: never a second sweep while one is in flight.
    if (this.running) return;
    this.running = true;
    try {
      const ceiling = this.config.get('ANALYTICS_RETENTION_DAYS', { infer: true });
      const textDays = this.config.get('ANALYTICS_QUERY_TEXT_DAYS', { infer: true });
      let removed = 0;
      for (const table of TABLES) {
        const t = Prisma.raw(table);
        // ponytail: created_at < … scans the table (its indexes lead with workspace_id); add a created_at index if a sweep gets slow
        removed += await this.batched(Prisma.sql`
          DELETE FROM ${t} WHERE id IN (
            SELECT e.id FROM ${t} e LEFT JOIN workspace_settings ws ON ws.workspace_id = e.workspace_id
             WHERE e.created_at < now() - make_interval(days => LEAST(COALESCE(ws.analytics_retention_days, ${ceiling}), ${ceiling})::int)
             LIMIT ${BATCH})`);
      }
      const redacted = await this.batched(Prisma.sql`
        UPDATE search_queries SET query_text = NULL WHERE id IN (
          SELECT id FROM search_queries
           WHERE query_text IS NOT NULL AND created_at < now() - make_interval(days => ${textDays}::int)
           LIMIT ${BATCH})`);
      if (removed || redacted) this.logger.log(`Analytics retention: ${removed} rows deleted, ${redacted} query texts redacted`);
    } catch (e) {
      this.logger.warn(`Analytics retention sweep failed (non-fatal): ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async batched(statement: Prisma.Sql): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const n = await this.prisma.$executeRaw(statement);
      total += n;
      if (n < BATCH) break;
    }
    return total;
  }
}
