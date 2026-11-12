import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ProjectVerificationSettings } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { PermissionService } from '../permissions/permission.service.js';
import { VerificationPolicyService } from './verification-policy.service.js';
import { UpdateProjectVerificationSettingsDto } from './verification.dto.js';

/**
 * A project's freshness thresholds (#921): review interval, reminder window,
 * inactivity and the empty-page size, each a sparse override of the
 * workspace's. Not behind the `knowledge-health` section switch: the
 * thresholds also decide page trust and the reminder sweep, which run with
 * the dashboard hidden.
 */
@ApiTags('projects')
@Controller('v1/projects')
export class ProjectVerificationSettingsController {
  constructor(
    private readonly policy: VerificationPolicyService,
    private readonly permissions: PermissionService,
  ) {}

  @Get(':id/settings/verification')
  @Returns('ProjectVerificationSettings')
  @Access('viewer', 'project')
  @ApiOperation({ summary: "A project's freshness thresholds: what the workspace set, what the project set, and what applies" })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectVerificationSettings> {
    return this.policy.projectSettings(id);
  }

  @Patch(':id/settings/verification')
  @Returns('ProjectVerificationSettings')
  @Access('editor', 'project')
  @ApiOperation({ summary: "Override thresholds for this project (workspace admin or the project's maintainer); null inherits the workspace's" })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectVerificationSettingsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProjectVerificationSettings> {
    await this.permissions.requireProjectManage(principal, id);
    return this.policy.updateProject(id, dto);
  }
}
