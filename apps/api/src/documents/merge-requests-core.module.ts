import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { ApiSpecsCoreModule } from '../api-specs/api-specs-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { ConflictsCoreModule } from '../conflicts/conflicts-core.module.js';
import { EntitiesCoreModule } from '../entities/entities-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { DocumentsCoreModule } from './documents-core.module.js';
import { LintCoreModule } from './lint/lint-core.module.js';
import { MergeRequestsService } from './merge-requests.service.js';

/**
 * MergeRequestsService with no controllers (#636, docs/features/71 finding 6):
 * the git process opens, updates and merges merge requests from a push.
 * `DocumentsModule` imports and re-exports it, so every call site resolves it
 * as before. Its AccessService comes from AuthCoreModule, not AuthModule's guards.
 */
@Module({
  imports: [
    DocumentsCoreModule,
    StorageModule,
    ActivityCoreModule,
    AuthCoreModule,
    NotificationsCoreModule,
    EventsModule,
    PermissionsCoreModule,
    ApiSpecsCoreModule,
    EntitiesCoreModule,
    LintCoreModule,
    ConflictsCoreModule,
  ],
  providers: [MergeRequestsService],
  exports: [MergeRequestsService],
})
export class MergeRequestsCoreModule {}
