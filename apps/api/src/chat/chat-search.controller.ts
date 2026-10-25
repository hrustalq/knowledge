import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { ChatSearchAvailability, ChatSearchResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ChatSearchService } from './chat-search.service.js';
import { ChatSearchDto } from './chat.dto.js';
import { Returns } from '../common/returns.decorator.js';

/** Chat search (#339), apart from page search: results are never mixed into `POST /v1/search`. */
@ApiTags('chat')
@Controller('v1/chat/search')
export class ChatSearchController {
  constructor(
    private readonly chat: ChatSearchService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @Returns('ChatSearchAvailability')
  @Access('viewer', 'query', { guests: true })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiOperation({ summary: 'Whether the caller may read any searchable group — the same ACL as the search, without a query' })
  async availability(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ChatSearchAvailability> {
    const readable = await this.chat.readableBindings(await this.permissions.scopeFor(principal, workspaceId));
    return { readable: readable.length > 0 };
  }

  @Post()
  @Returns('ChatSearchResponse')
  @HttpCode(200)
  // Guests too: a guest reads only the chat of projects they were granted (#76).
  @Access('viewer', 'body', { guests: true })
  @ApiOperation({ summary: 'Search the masked messages of searchable groups the caller may read' })
  async run(@Body() dto: ChatSearchDto, @CurrentPrincipal() principal: Principal): Promise<ChatSearchResponse> {
    return this.chat.search(await this.permissions.scopeFor(principal, dto.workspaceId), {
      query: dto.query,
      projectIds: dto.projectIds,
      bindingIds: dto.bindingIds,
      from: dto.from ? new Date(dto.from) : undefined,
      to: dto.to ? new Date(dto.to) : undefined,
      limit: dto.limit ?? 10,
    });
  }
}
