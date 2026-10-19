import { Module } from '@nestjs/common';
import { AnalyticsCoreModule } from './analytics-core.module.js';
import { AnalyticsController } from './analytics.controller.js';

/** Analytics over HTTP (#79). API-only: the beacon routes; recording itself is AnalyticsCoreModule's. */
@Module({
  imports: [AnalyticsCoreModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
