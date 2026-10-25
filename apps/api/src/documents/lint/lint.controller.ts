import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { LintPolicySettings, ListMergeRequestChecksResponse, MergeRequestCheckInfo } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../../auth/access.decorator.js';
import type { Principal } from '../../auth/principal.js';
import { ActivityService } from '../../activity/activity.service.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../../common/validation.js';
import { LintChecksService } from './lint-checks.service.js';
import { lintGateEnforced } from './lint-check.js';
import { LintTriggerSweeper } from './lint-trigger.sweeper.js';
import { LintPolicyQueryDto, UpdateLintPolicyDto } from './lint.dto.js';
import { Returns } from '../../common/returns.decorator.js';

/**
 * Merge request checks and the lint policy (#74, phase 2). Its own controller
 * so the module that starts runs stays out of DocumentsModule; every path has
 * more segments than `merge-requests/:id`, so declaration order across the two
 * controllers does not matter.
 */
@ApiTags('merge-requests')
@Controller('v1')
export class LintController {
  constructor(
    private readonly checks: LintChecksService,
    private readonly trigger: LintTriggerSweeper,
    private readonly activity: ActivityService,
  ) {}

  @Get('lint-policy')
  @Returns('LintPolicySettings')
  @Access('viewer', 'query')
  @ApiOperation({
    summary:
      "The style lint policy of the workspace or of one project: its own setting, what it inherits, the deployment's " +
      'ceiling and what applies',
  })
  policy(@Query() query: LintPolicyQueryDto): Promise<LintPolicySettings> {
    return this.checks.policyFor(query.workspaceId, query.projectId ?? null);
  }

  @Put('lint-policy')
  @Returns('LintPolicySettings')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Set the style lint policy of the workspace or of one project; null inherits' })
  async setPolicy(@Body() dto: UpdateLintPolicyDto, @CurrentPrincipal() principal: Principal): Promise<LintPolicySettings> {
    const settings = await this.checks.setPolicy(dto.workspaceId, dto.projectId ?? null, dto.policy, principal?.userId);
    await this.activity.record({
      workspaceId: dto.workspaceId,
      actor: principal?.userId,
      action: 'ai.lint-policy.updated',
      metadata: { projectId: dto.projectId ?? null, policy: dto.policy, effective: settings.effective },
    });
    return settings;
  }

  @Get('merge-requests/:id/checks')
  @Returns('ListMergeRequestChecksResponse')
  @Access('viewer', 'merge-request')
  @ApiOperation({
    summary: "A merge request's checks, newest first, with the lint policy of its page and whether it holds a merge by the caller",
  })
  list(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<ListMergeRequestChecksResponse> {
    return this.checks.list(id, lintGateEnforced(principal));
  }

  @Post('merge-requests/:id/checks/lint')
  @Access('editor', 'merge-request')
  @ApiOperation({
    summary: 'Lint the source head again. 409 while a check of that head is still waiting or running; 400 when lint is off',
  })
  async relint(@Param('id', ParseUUIDPipe) id: string): Promise<{ check: MergeRequestCheckInfo }> {
    const checkId = await this.trigger.relint(id);
    const { checks } = await this.checks.list(id, false);
    return { check: checks.find((c) => c.checkId === checkId)! };
  }
}
