import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ChatIdentitiesResponse, ChatIdentityEntry, ChatLinkPreview } from '@knowledge/contracts';
import { CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ChatIdentityService } from './chat-identity.service.js';
import { ChatLinkCodeDto } from './chat.dto.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * The person's side of linking (issue #71). No `@Access`: there is no
 * workspace in the request to resolve. The link code names it, and
 * `ChatIdentityService` asserts membership of that workspace explicitly; the
 * `me` routes act on `principal.userId` and take no id that could point at
 * anybody else's row.
 *
 * The code travels in a POST body rather than a query string, so it never
 * lands in an access log.
 */
@ApiTags('chat')
@Controller('v1')
export class ChatLinkController {
  constructor(private readonly identities: ChatIdentityService) {}

  @Post('chat/link/preview')
  @Returns('ChatLinkPreview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Who is asking to be linked, before confirming' })
  preview(@Body() dto: ChatLinkCodeDto, @CurrentPrincipal() principal: Principal): Promise<ChatLinkPreview> {
    return this.identities.preview(dto.code, principal);
  }

  @Post('chat/link')
  @Returns('ChatIdentityEntry')
  @ApiOperation({ summary: 'Link the messenger account that asked for this code to the signed-in person' })
  link(@Body() dto: ChatLinkCodeDto, @CurrentPrincipal() principal: Principal): Promise<ChatIdentityEntry> {
    return this.identities.confirm(dto.code, principal);
  }

  @Get('me/chat-identities')
  @Returns('ChatIdentitiesResponse')
  @ApiOperation({ summary: 'My linked messenger accounts' })
  async mine(@CurrentPrincipal() principal: Principal): Promise<ChatIdentitiesResponse> {
    return { identities: await this.identities.listMine(principal.userId) };
  }

  @Delete('me/chat-identities/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink one of my messenger accounts' })
  async unlink(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.identities.removeMine(id, principal.userId);
  }
}
