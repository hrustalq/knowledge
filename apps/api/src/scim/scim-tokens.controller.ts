import { Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, Post, Put, UseGuards, type CanActivate } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ScimSettingsView, ScimTokenCreated } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { scimEnabled } from './scim-enabled.js';
import { CreateScimTokenDto, PutScimSettingsDto } from './scim-tokens.dto.js';
import { ScimTokensService } from './scim-tokens.service.js';
import { Returns } from '../common/returns.decorator.js';

/** The admin routes 404 with the protocol ones, so the Provisioning tab can tell "off" from "empty". */
@Injectable()
export class ScimEnabledGuard implements CanActivate {
  private readonly on: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.on = scimEnabled(config);
  }

  canActivate(): boolean {
    if (!this.on) throw new NotFoundException(t('error.scim.disabled'));
    return true;
  }
}

/** SCIM provisioning settings and tokens (#75 phase 5), Settings → Security → Provisioning. Workspace admins only. */
@ApiTags('auth')
@Controller('v1/workspaces')
@UseGuards(ScimEnabledGuard)
export class ScimTokensController {
  constructor(private readonly tokens: ScimTokensService) {}

  @Get(':id/scim')
  @Returns('ScimSettingsView')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: "The workspace's SCIM base URL, live tokens, default role and what has been provisioned" })
  view(@Param('id', ParseUUIDPipe) id: string): Promise<ScimSettingsView> {
    return this.tokens.view(id);
  }

  @Put(':id/scim')
  @Returns('ScimSettingsView')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Set the role a provisioned user gets without a mapped group. Re-syncs provisioned members at once' })
  put(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutScimSettingsDto,
  ): Promise<ScimSettingsView> {
    return this.tokens.putSettings(id, dto.defaultRole, principal);
  }

  @Post(':id/scim-tokens')
  @Returns('ScimTokenCreated')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Mint a kscim_ bearer token for an IdP. The secret is in this response only' })
  create(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateScimTokenDto,
  ): Promise<ScimTokenCreated> {
    return this.tokens.create(id, dto.name, principal);
  }

  @Delete(':id/scim-tokens/:tokenId')
  @HttpCode(204)
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Revoke a SCIM token. The IdP gets 401 from its next request' })
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tokenId', ParseUUIDPipe) tokenId: string,
  ): Promise<void> {
    return this.tokens.revoke(id, tokenId, principal);
  }
}
