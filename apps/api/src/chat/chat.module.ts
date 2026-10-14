import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatAnswerSweeper } from './chat-answer.sweeper.js';
import { ChatAnswersService } from './chat-answers.service.js';
import { ChatIdentityService } from './chat-identity.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';
import { ChatLinkController } from './chat-link.controller.js';
import { ChatSettingsController } from './chat-settings.controller.js';
import { ChatWebhookController } from './chat-webhook.controller.js';

/**
 * Chat bots (issue #71). API-only, and a single module rather than the
 * Core/Queue/Worker quartet, because nothing here runs in the worker: an
 * answer is the pane's assistant turn, whose tool service is API-only, so it
 * runs here on a detached continuation (the feature-21 shape) with the
 * reaper as its crash recovery. When a later phase stages work for the worker
 * (saving a thread as a page), the services move into a ChatCoreModule then.
 */
@Module({
  imports: [PrismaModule, AgentCoreModule, AssistantModule],
  controllers: [ChatWebhookController, ChatSettingsController, ChatLinkController],
  providers: [ChatAdapterRegistry, ChatIntegrationsService, ChatIdentityService, ChatAnswersService, ChatAnswerSweeper],
})
export class ChatModule {}
