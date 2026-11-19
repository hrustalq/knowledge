import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ConfigurationProposal, ListConfigurationProposalsResponse, ProposeConfigurationResponse } from '@knowledge/contracts';
import { isValidTimezone } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe } from '../common/validation.js';
import { ConfiguratorService } from './configurator.service.js';
import { ConfigurationApplyService } from './configuration-apply.service.js';
import { ApplyConfigurationDto, ConfiguratorWorkspaceDto, ProposeConfigurationDto } from './configurator.dto.js';

/**
 * The configurator (#1250, docs/features/86). Editors draft; applying checks
 * the role each change needs on execution, so the route itself is `editor`.
 * Behind the `assistant` section, as every other drafting agent is.
 */
@ApiTags('ai')
@Feature('assistant')
@Controller('v1/ai/configurator')
export class ConfiguratorController {
  constructor(
    private readonly configurator: ConfiguratorService,
    private readonly applier: ConfigurationApplyService,
  ) {}

  @Post('proposals')
  @Returns('ProposeConfigurationResponse')
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Turn a goal into a configuration proposal',
    description:
      'The configurator reads the workspace\'s agents, schedules, triggers, projects and repository connectors and ' +
      'writes a proposal. Nothing is applied: every change waits for a person to apply it. `proposal` is null when ' +
      'it proposed nothing, and `reply` says why.',
  })
  propose(@Body() dto: ProposeConfigurationDto, @CurrentPrincipal() principal: Principal): Promise<ProposeConfigurationResponse> {
    const timezone = dto.timezone && isValidTimezone(dto.timezone) ? dto.timezone : null;
    return this.configurator.propose(dto.workspaceId, dto.goal.trim(), timezone, principal);
  }

  @Get('proposals')
  @Returns('ListConfigurationProposalsResponse')
  @Access('editor', 'query')
  @ApiOperation({ summary: 'Recent proposals, newest first: all of them for an admin, your own otherwise' })
  async list(@Query() query: ConfiguratorWorkspaceDto, @CurrentPrincipal() principal: Principal): Promise<ListConfigurationProposalsResponse> {
    return { proposals: await this.configurator.list(query.workspaceId, principal) };
  }

  @Post('proposals/:id/apply')
  @Returns('ConfigurationProposal')
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Apply some of a proposal\'s pending changes, all or nothing',
    description:
      'Each change needs its own role, checked now (every current kind: workspace admin); 403 and nothing written ' +
      'otherwise. A change that is already in place by now lands as `unavailable`. Schedules and triggers are ' +
      'written switched off.',
  })
  apply(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ApplyConfigurationDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ConfigurationProposal> {
    return this.applier.apply(id, dto.workspaceId, dto.changeIds, principal);
  }

  @Post('proposals/:id/dismiss')
  @Returns('ConfigurationProposal')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Set every pending change aside' })
  dismiss(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ConfiguratorWorkspaceDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ConfigurationProposal> {
    return this.configurator.dismiss(id, dto.workspaceId, principal);
  }
}
