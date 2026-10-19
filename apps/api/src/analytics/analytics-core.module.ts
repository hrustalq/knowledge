import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AnalyticsRecorder } from './analytics.recorder.js';

/**
 * Usage & search analytics (#79), controller-free so the API, the MCP stdio
 * server and the worker can all record. Search, MCP and the assistant's read
 * tools inject the recorder from here.
 */
@Module({
  imports: [PrismaModule],
  providers: [AnalyticsRecorder],
  exports: [AnalyticsRecorder],
})
export class AnalyticsCoreModule {}
