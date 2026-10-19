import { Body, ConflictException, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { KnowledgeConflictDto, ListConflictsResponse, ProposeAgentFindingResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PermissionService } from '../permissions/permission.service.js';
import { AgentFindingsService } from '../ai/agent-findings.service.js';
import { t } from '../i18n/t.js';
import { ConflictsService } from './conflicts.service.js';
import { CloseConflictDto, ListConflictsQueryDto } from './conflicts.dto.js';

/**
 * Contradictions between pages (#81, phase 5). Viewers read, editors act.
 * Every route answers under the caller's scope: a conflict with a page they
 * may not open does not exist for them.
 */
@ApiTags('conflicts')
@Controller('v1/conflicts')
export class ConflictsController {
  constructor(
    private readonly conflicts: ConflictsService,
    private readonly permissions: PermissionService,
    private readonly findings: AgentFindingsService,
  ) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Contradictions the arbiter found, newest first; only those whose pages the caller may open' })
  async list(@Query() query: ListConflictsQueryDto, @CurrentPrincipal() principal: Principal): Promise<ListConflictsResponse> {
    const scope = await this.permissions.scopeFor(principal, query.workspaceId);
    return { conflicts: await this.conflicts.list(scope, query) };
  }

  @Get(':id')
  @Access('viewer', 'conflict')
  @ApiOperation({ summary: 'One conflict with both quotes' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<KnowledgeConflictDto> {
    return this.conflicts.get(await this.scopeOf(id, principal), id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @Access('editor', 'conflict')
  @ApiOperation({ summary: 'Mark an open conflict resolved, with an optional note. 409 when it is no longer open' })
  async resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseConflictDto, @CurrentPrincipal() principal: Principal): Promise<KnowledgeConflictDto> {
    return this.conflicts.close(await this.scopeOf(id, principal), id, 'resolved', principal.userId, dto.note);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @Access('editor', 'conflict')
  @ApiOperation({ summary: 'Dismiss an open conflict as not one. It stays dismissed when found again' })
  async dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseConflictDto, @CurrentPrincipal() principal: Principal): Promise<KnowledgeConflictDto> {
    return this.conflicts.close(await this.scopeOf(id, principal), id, 'dismissed', principal.userId, dto.note);
  }

  /**
   * Turn the conflict into a merge request on its first page, through the
   * finding that reported it — the same path, model call and claim as the
   * runs panel's Propose. Attributed to the caller. 409 `already-proposed`
   * on a second press.
   */
  @Post(':id/propose')
  @HttpCode(200)
  @Access('editor', 'conflict')
  @ApiOperation({ summary: 'Open a merge request that fixes the conflict on its first page. 409 when one was proposed already' })
  async propose(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<ProposeAgentFindingResponse> {
    const scope = await this.scopeOf(id, principal);
    const conflict = await this.conflicts.get(scope, id);
    const source = await this.conflicts.source(id);
    if (conflict.mergeRequestId) {
      throw new ConflictException({ statusCode: 409, message: t('error.conflict.alreadyProposed'), reason: 'already-proposed', mergeRequestId: conflict.mergeRequestId });
    }
    if (conflict.status !== 'open' || !source.agentRunId || source.findingIndex === null) {
      throw new ConflictException({ statusCode: 409, message: t('error.conflict.notOpen'), reason: 'conflict-not-open', status: conflict.status });
    }
    const proposed = await this.findings.propose(source.workspaceId, source.agentRunId, source.findingIndex, principal);
    await this.conflicts.markProposed(source.workspaceId, id, proposed.mergeRequestId, conflict.a.documentId);
    return proposed;
  }

  private async scopeOf(id: string, principal: Principal) {
    return this.permissions.scopeFor(principal, await this.conflicts.workspaceOf(id));
  }
}
