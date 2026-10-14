import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { FeedbackCoreModule } from '../feedback/feedback-core.module.js';
import { GlossaryCoreModule } from '../glossary/glossary-core.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatAnswerSweeper } from './chat-answer.sweeper.js';
import { ChatAnswersService } from './chat-answers.service.js';
import { ChatCapturesService } from './chat-captures.service.js';
import { ChatIdentityService } from './chat-identity.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';
import { ChatLinkController } from './chat-link.controller.js';
import { ChatSettingsController } from './chat-settings.controller.js';
import { ChatSubscriptionSweeper } from './chat-subscription.sweeper.js';
import { ChatSubscriptionsService } from './chat-subscriptions.service.js';
import { ChatWebhookController } from './chat-webhook.controller.js';

/**
 * Chat bots (issue #71). API-only, and a single module rather than the
 * Core/Queue/Worker quartet, because nothing here runs in the worker: an
 * answer is the pane's assistant turn, whose tool service is API-only, so it
 * runs here on a detached continuation (the feature-21 shape) with the
 * reaper as its crash recovery. Saving a conversation (phase 2) runs the same
 * way: the draft is one completion and publishing needs the API-only merge
 * request service, so nothing here is staged for the worker. Channel
 * notifications (phase 3) are delivered from here too, by
 * ChatSubscriptionSweeper: the token and the adapters are already here, and a
 * post to a group is attributed to nobody.
 */
@Module({
  imports: [
    PrismaModule,
    AgentCoreModule,
    AiCoreModule,
    AssistantModule,
    AssistantClientModule,
    DocumentsModule,
    FeedbackCoreModule,
    GlossaryCoreModule,
    GraphModule,
    StorageModule,
  ],
  controllers: [ChatWebhookController, ChatSettingsController, ChatLinkController],
  providers: [
    ChatAdapterRegistry,
    ChatIntegrationsService,
    ChatIdentityService,
    ChatAnswersService,
    ChatCapturesService,
    ChatAnswerSweeper,
    ChatSubscriptionsService,
    ChatSubscriptionSweeper,
  ],
})
export class ChatModule {}
