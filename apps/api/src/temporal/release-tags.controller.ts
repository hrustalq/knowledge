import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GraphTimelineResponse, ListReleaseTagsResponse, ReleaseTagDto } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ReleaseTagsService } from './release-tags.service.js';
import { CreateReleaseTagDto, GraphTimelineQueryDto, ListReleaseTagsQueryDto } from './temporal.dto.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * Release tags and the graph timeline (#81, phase 2). A tag is a named
 * instant `asOf=tag:<name>` resolves to; the timeline is what the graph's
 * time slider draws. Viewers read, editors tag, admins remove a tag.
 */
@ApiTags('graph')
@Controller('v1')
export class ReleaseTagsController {
  constructor(
    private readonly tags: ReleaseTagsService,
    private readonly permissions: PermissionService,
  ) {}

  @Get('release-tags')
  @Returns('ListReleaseTagsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Release tags of the workspace, oldest first' })
  async list(@Query() query: ListReleaseTagsQueryDto): Promise<ListReleaseTagsResponse> {
    return { tags: await this.tags.list(query.workspaceId, query.projectId) };
  }

  @Post('release-tags')
  @Returns('ReleaseTagDto')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Name an instant (now, or `at`) so the graph can be read as of it. 409 on a duplicate name' })
  create(@Body() dto: CreateReleaseTagDto, @CurrentPrincipal() principal: Principal): Promise<ReleaseTagDto> {
    return this.tags.create(dto, principal.userId);
  }

  @Delete('release-tags/:id')
  @Access('admin', 'release-tag')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a release tag. What the graph said at that instant is unaffected' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.tags.delete(id);
  }

  @Get('graph/timeline')
  @Returns('GraphTimelineResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Markers for the graph time slider: release tags and per-day fact changes in a window' })
  async timeline(@Query() query: GraphTimelineQueryDto, @CurrentPrincipal() principal: Principal): Promise<GraphTimelineResponse> {
    return this.tags.timeline(await this.permissions.scopeFor(principal, query.workspaceId), query);
  }
}
