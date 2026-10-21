import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TrackerRouteResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../../auth/access.decorator.js';
import type { Principal } from '../../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../../common/validation.js';
import { WorkItemHandoffService } from './work-item-handoff.service.js';
import { PutTrackerRouteDto } from './work-items.dto.js';

/**
 * Which tracker a knowledge project hands off to (#424). Reading it is any
 * member's business (the chip shows where a ticket would go); changing it is
 * an admin's, like editing the connector it points at.
 */
@ApiTags('work-items')
@Controller('v1/projects')
export class TrackerRoutesController {
  constructor(private readonly handoffs: WorkItemHandoffService) {}

  @Get(':id/tracker-route')
  @Access('viewer', 'project')
  @ApiOperation({ summary: "The project's tracker route, or null when it has none" })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<TrackerRouteResponse> {
    return { route: await this.handoffs.route(id) };
  }

  @Put(':id/tracker-route')
  @Access('admin', 'project')
  @ApiOperation({ summary: 'Route the project to a tracker connector, with an optional Jira project, issue type or GitHub org board' })
  async put(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutTrackerRouteDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TrackerRouteResponse> {
    return { route: await this.handoffs.putRoute(id, dto, principal.userId) };
  }

  @Delete(':id/tracker-route')
  @Access('admin', 'project')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the route; existing tickets keep syncing' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.handoffs.deleteRoute(id);
  }
}
