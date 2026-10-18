import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { FeedbackCoreModule } from '../feedback/feedback-core.module.js';
import { VerificationPolicyModule } from '../verification/verification-policy.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ApiSpecsCoreModule } from '../api-specs/api-specs-core.module.js';
import { DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';

/**
 * Document reads and writes with no controllers and no auth dependencies.
 *
 * This exists so the connector worker (docs/features/19) can create pages,
 * write revisions and finalize them in bulk. DocumentsModule cannot be loaded
 * into WorkerModule: it carries controllers, and MergeRequestsService injects
 * AccessService from the global AuthModule, which the worker never registers.
 * Feature 17 worked around that with an API-side materialize sweeper — the
 * right shape for a rare path, but a pull of several hundred pages would
 * trickle through a sweep interval, so connectors need the real service.
 *
 * Same split as AiCoreModule / WorkflowCoreModule / EventsModule: DocumentsModule
 * imports this and re-exports it, so every existing `imports: [DocumentsModule]`
 * keeps resolving DocumentsService unchanged.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    GraphModule,
    IngestionModule,
    ActivityCoreModule,
    ProjectsCoreModule,
    // Writing a page subscribes its author to it (docs/features/22). Core, so
    // this stays worker-loadable.
    NotificationsCoreModule,
    // The open-report count that turns a stamp into `flagged` (docs/features/38)
    // and the workspace's freshness policy (docs/features/39). Both leaves.
    FeedbackCoreModule,
    VerificationPolicyModule,
    // Creating a page from a template (issue #69). Core, so still worker-loadable.
    TemplatesCoreModule,
    // `restricted_by` is rewritten in the same transaction as a move (#76). A leaf.
    PermissionsCoreModule,
    // A spec document is validated at finalize (#78). A leaf.
    ApiSpecsCoreModule,
  ],
  // CompareService too: a merge request's lint reads its diff in the worker
  // (#74). Prisma, storage, graph and the spec diff — all already here.
  providers: [DocumentsService, CompareService],
  exports: [DocumentsService, CompareService],
})
export class DocumentsCoreModule {}
