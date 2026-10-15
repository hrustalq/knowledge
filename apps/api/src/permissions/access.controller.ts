import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EffectiveAccessResponse, ResourceAccessResponse } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ResourceAccessService } from './resource-access.service.js';
import { UpdateResourceAccessDto } from './permissions.dto.js';

/**
 * Page and project restrictions (#76). Every route is `viewer` on the node
 * itself, so the guard has already refused anyone who cannot open it; the
 * writes and the "who can see this" list additionally need `manage` there,
 * which only the service can work out — it depends on the grants.
 */
@ApiTags('access')
@Controller('v1')
export class AccessController {
  constructor(private readonly access: ResourceAccessService) {}

  // Literal segments under :id/access first — Nest matches in declaration order.
  @Get('documents/:id/access/effective')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Who can open this page and at what level (needs manage on it)' })
  documentEffective(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EffectiveAccessResponse> {
    return this.access.effective(principal, { type: 'document', id });
  }

  @Get('documents/:id/access')
  @Access('viewer', 'document')
  @ApiOperation({
    summary: "The page's restriction, the restrictions it inherits and the caller's level; grants only for a manager",
  })
  documentAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ResourceAccessResponse> {
    return this.access.get(principal, { type: 'document', id });
  }

  @Put('documents/:id/access')
  @Access('viewer', 'document')
  @ApiOperation({
    summary: "Set the page's restriction and replace its grants (needs manage; 409 when it would lock the caller out)",
  })
  updateDocumentAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResourceAccessDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ResourceAccessResponse> {
    return this.access.update(principal, { type: 'document', id }, dto);
  }

  @Get('projects/:id/access/effective')
  @Access('viewer', 'project')
  @ApiOperation({ summary: 'Who can open this project and at what level (needs manage on it)' })
  projectEffective(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EffectiveAccessResponse> {
    return this.access.effective(principal, { type: 'project', id });
  }

  @Get('projects/:id/access')
  @Access('viewer', 'project')
  @ApiOperation({ summary: "The project's restriction and the caller's level; grants only for a manager" })
  projectAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ResourceAccessResponse> {
    return this.access.get(principal, { type: 'project', id });
  }

  @Put('projects/:id/access')
  @Access('viewer', 'project')
  @ApiOperation({ summary: "Set the project's restriction and replace its grants (needs manage on it)" })
  updateProjectAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResourceAccessDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ResourceAccessResponse> {
    return this.access.update(principal, { type: 'project', id }, dto);
  }
}
