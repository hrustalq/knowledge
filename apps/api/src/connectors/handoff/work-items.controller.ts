import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ConnectorWorkItemResponse, ListAnchorWorkItemsResponse, WorkItemRulesResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../../auth/access.decorator.js';
import type { Principal } from '../../auth/principal.js';
import { WorkItemHandoffService } from './work-item-handoff.service.js';
import { WorkItemRulesService } from './work-item-rules.service.js';
import { AnchorWorkItemsQueryDto, PutWorkItemRulesDto, WorkItemHandoffDto, WorkItemRulesQueryDto } from './work-items.dto.js';

/**
 * Work items by what they are for (#424), rather than by connector: the chip on
 * an issue, a conflict or a page asks "what ticket does this have", and the
 * handoff answers "give it one". The page-level check (edit to hand off, view
 * to see) happens in the service, against the anchor's page.
 */
@ApiTags('work-items')
@Controller('v1/work-items')
export class WorkItemsController {
  constructor(
    private readonly handoffs: WorkItemHandoffService,
    private readonly rules: WorkItemRulesService,
  ) {}

  @Get('rules')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'The handoff rules, and the env ceiling they run under' })
  getRules(@Query() query: WorkItemRulesQueryDto): Promise<WorkItemRulesResponse> {
    return this.rules.get(query.workspaceId);
  }

  @Put('rules')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Turn handoff rules on or off; each creates tickets only into a project with a tracker route' })
  putRules(@Body() dto: PutWorkItemRulesDto, @CurrentPrincipal() principal: Principal): Promise<WorkItemRulesResponse> {
    return this.rules.set(
      dto.workspaceId,
      { issues: dto.issues ?? null, conflicts: dto.conflicts ?? null, verification: dto.verification ?? null },
      principal.userId,
    );
  }

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Tickets anchored on one knowledge object; ones on pages the caller cannot open are left out' })
  async list(@Query() query: AnchorWorkItemsQueryDto, @CurrentPrincipal() principal: Principal): Promise<ListAnchorWorkItemsResponse> {
    return { workItems: await this.handoffs.forAnchor(principal, query.workspaceId, query.sourceKind, query.sourceId) };
  }

  @Post('handoff')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Create a ticket for a knowledge object in its tracker, or attach an existing one (idempotent per connector)' })
  async handoff(@Body() dto: WorkItemHandoffDto, @CurrentPrincipal() principal: Principal): Promise<ConnectorWorkItemResponse> {
    return { workItem: await this.handoffs.handoff(principal, dto) };
  }
}
