import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AgentTriggerCoreModule } from '../agents/agent-trigger-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { DocumentsCoreModule } from './documents-core.module.js';
import { MergeRequestsCoreModule } from './merge-requests-core.module.js';
import { MentionRepliesService } from './mention-replies.service.js';
import { MergeRequestThreadsService } from './merge-request-threads.service.js';

/**
 * Review threads and the agent mention replies they start (docs/features/21),
 * controller-free, so MCP's knowledge_comment_merge_request loads them without
 * DocumentsModule (#822). MentionReplySweeper stays in DocumentsModule: a
 * sweeper belongs to the API process, never to every stdio MCP client.
 */
@Module({
  imports: [
    DocumentsCoreModule,
    MergeRequestsCoreModule,
    AuthCoreModule,
    AgentCoreModule,
    AgentTriggerCoreModule,
    AiCoreModule,
    AssistantClientModule,
    EventsModule,
    NotificationsCoreModule,
    PermissionsCoreModule,
  ],
  providers: [MentionRepliesService, MergeRequestThreadsService],
  exports: [MentionRepliesService, MergeRequestThreadsService],
})
export class MergeRequestThreadsCoreModule {}
