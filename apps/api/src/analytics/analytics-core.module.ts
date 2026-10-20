import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AnalyticsQueryService } from './analytics-query.service.js';
import { AnalyticsRecorder } from './analytics.recorder.js';
import { AnalyticsSettingsService } from './analytics-settings.service.js';

/**
 * Usage & search analytics (#79), controller-free so the API, the MCP stdio
 * server and the worker can all record. Search, MCP and the assistant's read
 * tools inject the recorder from here; the rollups are here too, for the MCP
 * tools that read them. Knowledge health reads `read-signals.ts` directly.
 */
@Module({
  imports: [PrismaModule],
  providers: [AnalyticsRecorder, AnalyticsQueryService, AnalyticsSettingsService],
  exports: [AnalyticsRecorder, AnalyticsQueryService, AnalyticsSettingsService],
})
export class AnalyticsCoreModule {}
