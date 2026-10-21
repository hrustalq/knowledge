import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ConnectorWorkItemResponse, ListAnchorWorkItemsResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../../auth/access.decorator.js';
import type { Principal } from '../../auth/principal.js';
import { WorkItemHandoffService } from './work-item-handoff.service.js';
import { AnchorWorkItemsQueryDto, WorkItemHandoffDto } from './work-items.dto.js';

/**
 * Work items by what they are for (#424), rather than by connector: the chip on
 * an issue, a conflict or a page asks "what ticket does this have", and the
 * handoff answers "give it one". The page-level check (edit to hand off, view
 * to see) happens in the service, against the anchor's page.
 */
@ApiTags('work-items')
@Controller('v1/work-items')
export class WorkItemsController {
  constructor(private readonly handoffs: WorkItemHandoffService) {}

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
