import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AnalyticsRetentionSweeper } from './analytics-retention.sweeper.js';

/** Analytics retention (#79) — imported ONLY by the worker entrypoint, so one process sweeps. */
@Module({
  imports: [PrismaModule],
  providers: [AnalyticsRetentionSweeper],
})
export class AnalyticsWorkerModule {}
