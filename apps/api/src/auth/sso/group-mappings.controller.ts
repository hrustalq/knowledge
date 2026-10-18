import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GroupMappingView, ListGroupMappingsResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../access.decorator.js';
import type { Principal } from '../principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../../common/validation.js';
import { UpsertGroupMappingDto } from './identity-providers.dto.js';
import { GroupMappingsService } from './group-mappings.service.js';
import { SsoEnabledGuard } from './sso-enabled.guard.js';

/** IdP group → workspace role mappings (#75), Settings → Security → Group mapping. Workspace admins only. */
@ApiTags('auth')
@Controller('v1/workspaces')
@UseGuards(SsoEnabledGuard)
export class GroupMappingsController {
  constructor(private readonly mappings: GroupMappingsService) {}

  @Get(':id/group-mappings')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: "The workspace's group → role mappings, and the providers a mapping may name" })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<ListGroupMappingsResponse> {
    return this.mappings.list(id);
  }

  @Post(':id/group-mappings')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Map a provider group to a role. The same group again replaces its role. Applies at next sign-in' })
  upsert(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertGroupMappingDto,
  ): Promise<GroupMappingView> {
    return this.mappings.upsert(id, dto, principal);
  }

  @Delete(':id/group-mappings/:mappingId')
  @HttpCode(204)
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Remove a mapping. Memberships it granted stay until the next sign-in re-syncs them' })
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
  ): Promise<void> {
    return this.mappings.remove(id, mappingId, principal);
  }
}
