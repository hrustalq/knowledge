import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  ChatBindingEntry,
  ChatBindingsResponse,
  ChatIdentitiesResponse,
  ChatIntegrationSummary,
  ChatIntegrationTestResponse,
  ChatIntegrationsResponse,
  ChatSearchSettings,
  ChatSubscriptionEntry,
  ChatSubscriptionsResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ChatIdentityService } from './chat-identity.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';
import { ChatMessagesService } from './chat-messages.service.js';
import { ChatSubscriptionsService } from './chat-subscriptions.service.js';
import {
  CreateChatBindingDto,
  CreateChatIntegrationDto,
  CreateChatSubscriptionDto,
  UpdateChatBindingDto,
  UpdateChatIntegrationDto,
  UpdateChatSearchSettingsDto,
  UpdateChatSubscriptionDto,
} from './chat.dto.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * /settings/chat (issue #71): bots, the groups they answer in, and who is
 * linked. All of it is a workspace admin's — a binding is an admin asserting
 * that everyone in that group may read what the workspace's members can.
 */
@ApiTags('chat')
@Controller('v1/chat')
export class ChatSettingsController {
  constructor(
    private readonly integrations: ChatIntegrationsService,
    private readonly identities: ChatIdentityService,
    private readonly subscriptions: ChatSubscriptionsService,
    private readonly messages: ChatMessagesService,
  ) {}

  @Get('search-settings')
  @Returns('ChatSearchSettings')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Searchable chat (#339): whether it is available, and the retention asked for vs. applied' })
  searchSettings(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ChatSearchSettings> {
    return this.messages.settings(workspaceId);
  }

  @Patch('search-settings')
  @Returns('ChatSearchSettings')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Shorten how long searchable groups’ messages are kept; null inherits CHAT_SEARCH_RETENTION_DAYS' })
  updateSearchSettings(@Body() dto: UpdateChatSearchSettingsDto, @CurrentPrincipal() principal: Principal): Promise<ChatSearchSettings> {
    return this.messages.setRetention(dto.workspaceId, dto.retentionDays, principal.userId);
  }

  @Get('integrations')
  @Returns('ChatIntegrationsResponse')
  @Access('admin', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'The workspace’s chat bots. Tokens are never returned, only a hint' })
  list(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ChatIntegrationsResponse> {
    return this.integrations.list(workspaceId);
  }

  @Post('integrations')
  @Returns('ChatIntegrationSummary')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Connect a bot: the token is checked with the platform, then the webhook is set' })
  @ApiResponse({ status: 409, description: 'Name taken in the workspace, or the bot is connected elsewhere (details.reason)' })
  create(@Body() dto: CreateChatIntegrationDto, @CurrentPrincipal() principal: Principal): Promise<ChatIntegrationSummary> {
    return this.integrations.create(dto, principal.userId);
  }

  @Patch('integrations/:id')
  @Returns('ChatIntegrationSummary')
  @Access('admin', 'chat-integration')
  @ApiOperation({ summary: 'Rename, switch off, replace the token or change the default agent or language' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChatIntegrationDto): Promise<ChatIntegrationSummary> {
    return this.integrations.update(id, dto);
  }

  @Delete('integrations/:id')
  @Access('admin', 'chat-integration')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disconnect a bot, with its bindings and linked accounts' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.integrations.remove(id);
  }

  @Post('integrations/:id/test')
  @Returns('ChatIntegrationTestResponse')
  @Access('admin', 'chat-integration')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the token and set the webhook again' })
  test(@Param('id', ParseUUIDPipe) id: string): Promise<ChatIntegrationTestResponse> {
    return this.integrations.test(id);
  }

  @Get('integrations/:id/bindings')
  @Returns('ChatBindingsResponse')
  @Access('admin', 'chat-integration')
  @ApiOperation({ summary: 'The groups this bot answers in' })
  bindings(@Param('id', ParseUUIDPipe) id: string): Promise<ChatBindingsResponse> {
    return this.integrations.listBindings(id);
  }

  @Post('integrations/:id/bindings')
  @Returns('ChatBindingEntry')
  @Access('admin', 'chat-integration')
  @ApiOperation({ summary: 'Let the bot answer in a group, by its chat id' })
  createBinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateChatBindingDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ChatBindingEntry> {
    return this.integrations.createBinding(id, dto, principal.userId);
  }

  @Patch('bindings/:id')
  @Returns('ChatBindingEntry')
  @Access('admin', 'chat-binding')
  @ApiOperation({ summary: 'Change a group’s project, agent, answer mode, language, listening, automatic harvest or searchability' })
  updateBinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChatBindingDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ChatBindingEntry> {
    return this.integrations.updateBinding(id, dto, principal.userId);
  }

  @Delete('bindings/:id')
  @Access('admin', 'chat-binding')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop answering in a group' })
  async removeBinding(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.integrations.removeBinding(id);
  }

  @Get('bindings/:id/subscriptions')
  @Returns('ChatSubscriptionsResponse')
  @Access('admin', 'chat-binding')
  @ApiOperation({ summary: 'What a group is told about: pages published or updated, merge requests opened or merged' })
  async subscriptionsOf(@Param('id', ParseUUIDPipe) id: string): Promise<ChatSubscriptionsResponse> {
    return { subscriptions: await this.subscriptions.list(id) };
  }

  @Post('bindings/:id/subscriptions')
  @Returns('ChatSubscriptionEntry')
  @Access('admin', 'chat-binding')
  @ApiOperation({ summary: 'Tell a group about changes, instantly or as a digest. Only titles and links are sent' })
  @ApiResponse({ status: 400, description: 'A digest without a window, or a project from another workspace' })
  createSubscription(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateChatSubscriptionDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ChatSubscriptionEntry> {
    return this.subscriptions.create(id, dto, principal.userId);
  }

  @Patch('subscriptions/:id')
  @Returns('ChatSubscriptionEntry')
  @Access('admin', 'chat-subscription')
  @ApiOperation({ summary: 'Change what a group is told about, or how often' })
  updateSubscription(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChatSubscriptionDto): Promise<ChatSubscriptionEntry> {
    return this.subscriptions.update(id, dto);
  }

  @Delete('subscriptions/:id')
  @Access('admin', 'chat-subscription')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop telling a group about changes' })
  async removeSubscription(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.subscriptions.remove(id);
  }

  @Get('integrations/:id/identities')
  @Returns('ChatIdentitiesResponse')
  @Access('admin', 'chat-integration')
  @ApiOperation({ summary: 'Messenger accounts linked to people through this bot' })
  async identitiesOf(@Param('id', ParseUUIDPipe) id: string): Promise<ChatIdentitiesResponse> {
    return { identities: await this.identities.listForIntegration(id) };
  }

  @Delete('integrations/:id/identities/:identityId')
  @Access('admin', 'chat-integration')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink an account; it gets no answers until it is linked again' })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('identityId', ParseUUIDPipe) identityId: string,
  ): Promise<void> {
    await this.identities.removeForIntegration(id, identityId);
  }
}
