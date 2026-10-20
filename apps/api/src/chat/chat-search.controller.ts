import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ChatSearchResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ChatSearchService } from './chat-search.service.js';
import { ChatSearchDto } from './chat.dto.js';

/** Chat search (#339), apart from page search: results are never mixed into `POST /v1/search`. */
@ApiTags('chat')
@Controller('v1/chat/search')
export class ChatSearchController {
  constructor(
    private readonly chat: ChatSearchService,
    private readonly permissions: PermissionService,
  ) {}

  @Post()
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
