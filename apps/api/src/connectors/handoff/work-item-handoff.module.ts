import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../../activity/activity-core.module.js';
import { AuthCoreModule } from '../../auth/auth-core.module.js';
import { ConflictsCoreModule } from '../../conflicts/conflicts-core.module.js';
import { PermissionsCoreModule } from '../../permissions/permissions-core.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { VerificationCoreModule } from '../../verification/verification-core.module.js';
import { ConnectorWorkItemsModule } from '../connector-work-items.module.js';
import { ConnectorsCoreModule } from '../connectors-core.module.js';
import { WorkItemAnchorsService } from './work-item-anchors.service.js';
import { WorkItemHandoffService } from './work-item-handoff.service.js';
import { WorkItemSyncSweeper } from './work-item-sync.sweeper.js';

/**
 * Tracker handoff (#424): the handoff service and the sync sweeper.
 * API-only — imported by `ConnectorsModule` and nothing the worker loads —
 * because the sweeper writes to trackers and resolves reports in a person's
 * name, and two processes running it would double every transition.
 */
@Module({
  imports: [
    PrismaModule,
    AuthCoreModule,
    PermissionsCoreModule,
    ActivityCoreModule,
    ConflictsCoreModule,
    VerificationCoreModule,
    ConnectorsCoreModule,
    ConnectorWorkItemsModule,
  ],
  providers: [WorkItemAnchorsService, WorkItemHandoffService, WorkItemSyncSweeper],
  exports: [WorkItemAnchorsService, WorkItemHandoffService],
})
export class WorkItemHandoffModule {}
