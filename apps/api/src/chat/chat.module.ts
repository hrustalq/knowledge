import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { CapturesModule } from '../captures/captures.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { EventsModule } from '../events/events.module.js';
import { FeedbackCoreModule } from '../feedback/feedback-core.module.js';
import { GlossaryCoreModule } from '../glossary/glossary-core.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { SearchCoreModule } from '../search/search-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatAnswerSweeper } from './chat-answer.sweeper.js';
import { ChatAutoHarvestSweeper } from './chat-auto-harvest.sweeper.js';
import { ChatAnswersService } from './chat-answers.service.js';
import { ChatBufferService } from './chat-buffer.service.js';
import { ChatCapturesService } from './chat-captures.service.js';
import { ChatIdentityService } from './chat-identity.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';
import { ChatLinkController } from './chat-link.controller.js';
import { ChatMessagesService } from './chat-messages.service.js';
import { ChatSettingsController } from './chat-settings.controller.js';
import { ChatSocketSupervisor } from './chat-socket.supervisor.js';
import { ChatSubscriptionSweeper } from './chat-subscription.sweeper.js';
import { ChatSubscriptionsService } from './chat-subscriptions.service.js';
import { ChatWebhookController } from './chat-webhook.controller.js';
import { HarvestService } from './harvest.service.js';

/**
 * Chat bots (issue #71). API-only, and a single module rather than the
 * Core/Queue/Worker quartet, because nothing here runs in the worker: an
 * answer is the pane's assistant turn, whose tool service is API-only, so it
 * runs here on a detached continuation (the feature-21 shape) with the
 * reaper as its crash recovery. Saving an answer (phase 2) is an agent-memory
 * capture (#82), so it is CapturesModule's path, sweeper included. Channel
 * notifications (phase 3) are delivered from here too, by
 * ChatSubscriptionSweeper: the token and the adapters are already here, and a
 * post to a group is attributed to nobody. Time's websockets (phase 4) are
 * held here by ChatSocketSupervisor, which feeds the same answer path.
 * Harvesting a thread into captures (#82) is HarvestService: API-side for the
 * same reason Save is, and fed by the same dispatch; Telegram's threads come
 * from ChatBufferService, which keeps a listening group's messages masked.
 * ChatAutoHarvestSweeper (#340) harvests a listening group's quiet threads
 * without anyone asking, as the admin who opted the group in — here, not in
 * the worker, for the same reason: a capture is a person's act.
 * ChatMessagesService (#339) keeps a searchable group's messages, masked,
 * apart from the harvest buffer.
 */
@Module({
  imports: [
    PrismaModule,
    AgentCoreModule,
    AiCoreModule,
    AssistantModule,
    AssistantClientModule,
    CapturesModule,
    DocumentsModule,
    EventsModule,
    FeedbackCoreModule,
    GlossaryCoreModule,
    GraphModule,
    NotificationsCoreModule,
    PermissionsCoreModule,
    SearchCoreModule,
    StorageModule,
  ],
  controllers: [ChatWebhookController, ChatSettingsController, ChatLinkController],
  providers: [
    ChatAdapterRegistry,
    ChatIntegrationsService,
    ChatIdentityService,
    ChatAnswersService,
    ChatBufferService,
    ChatMessagesService,
    ChatCapturesService,
    ChatAnswerSweeper,
    ChatAutoHarvestSweeper,
    ChatSubscriptionsService,
    ChatSubscriptionSweeper,
    ChatSocketSupervisor,
    HarvestService,
  ],
})
export class ChatModule {}
