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
import { WorkItemRulesService } from './work-item-rules.service.js';
import { NotificationsCoreModule } from '../../notifications/notifications-core.module.js';

/**
 * Tracker handoff (#424): the handoff, anchor and rules services, controller-
 * free so the MCP surface can call them too. The sync sweeper is NOT here: it
 * is provided by `ConnectorsModule`, which only the API process loads, so the
 * stdio MCP server importing this module does not start a second sweeper.
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
    NotificationsCoreModule,
  ],
  providers: [WorkItemAnchorsService, WorkItemHandoffService, WorkItemRulesService],
  exports: [WorkItemAnchorsService, WorkItemHandoffService, WorkItemRulesService],
})
export class WorkItemHandoffModule {}
