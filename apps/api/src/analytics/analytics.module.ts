import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { AnalyticsCoreModule } from './analytics-core.module.js';
import { AnalyticsController } from './analytics.controller.js';

/** Analytics over HTTP (#79). API-only: the beacon and the dashboards' reads; recording and rollups are AnalyticsCoreModule's. */
@Module({
  imports: [AnalyticsCoreModule, PermissionsCoreModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
