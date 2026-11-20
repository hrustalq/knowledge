import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags, OmitType } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { OAUTH_GRANT_DEFAULT_DAYS, type OAuthDecisionResponse, type OAuthRequestView } from '@knowledge/contracts';
import { CurrentPrincipal, SessionOnly } from '../auth/access.decorator.js';
import { CreateApiKeyDto } from '../auth/api-keys.dto.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe } from '../common/validation.js';
import { OAuthService } from './oauth.service.js';

export class ApproveOAuthDto extends OmitType(CreateApiKeyDto, ['name', 'expiresInDays'] as const) {
  @ApiPropertyOptional({ type: Number, description: `Days until the grant ends (1–365); omitted means ${OAUTH_GRANT_DEFAULT_DAYS}.` })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

/**
 * The consent screen's half of OAuth for MCP (#1352): the web page at
 * `/oauth/authorize?request=` reads a pending authorize request here and answers
 * it. Session-only — a grant is made by a signed-in person in the browser, so a
 * key or a client's own token can never create or widen one.
 */
@ApiTags('oauth')
@SessionOnly()
@Controller('v1/oauth/requests')
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  @Get(':id')
  @ApiOperation({ summary: 'A pending MCP client sign-in, as the consent screen shows it' })
  @Returns('OAuthRequestView')
  view(@Param('id', ParseUuidPipe) id: string): Promise<OAuthRequestView> {
    return this.oauth.view(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve an MCP client sign-in: what it may do, then the redirect back to it' })
  @Returns('OAuthDecisionResponse')
  approve(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ApproveOAuthDto,
  ): Promise<OAuthDecisionResponse> {
    return this.oauth.approve(principal, id, dto);
  }

  @Post(':id/deny')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refuse an MCP client sign-in: the redirect back to it, carrying access_denied' })
  @Returns('OAuthDecisionResponse')
  deny(@Param('id', ParseUuidPipe) id: string): Promise<OAuthDecisionResponse> {
    return this.oauth.deny(id);
  }
}
