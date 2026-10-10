import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { KnowledgeIssuesService } from './knowledge-issues.service.js';

/**
 * Reports against pages (docs/features/38, phase 3), controller-free so the
 * MCP tool set can share it with the REST routes — but **not** a `*CoreModule`:
 * filing a report may open a merge request, which needs `DocumentsModule`, and
 * that never loads in the worker. The worker reads `knowledge_issues` through
 * Prisma alone (the sentinel's `checkReport`, the provenance count).
 *
 * `FeedbackModule` (API) adds the controller and the publisher; `McpCoreModule`
 * imports this for `knowledge_report_issue`.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthCoreModule,
    DocumentsModule,
    ActivityCoreModule,
    NotificationsCoreModule,
    EventsModule,
    AgentCoreModule,
    AgentQueueModule,
  ],
  providers: [KnowledgeIssuesService],
  exports: [KnowledgeIssuesService],
})
export class KnowledgeIssuesModule {}
