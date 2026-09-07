import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateProjectResponse,
  ListProjectsResponse,
  ProjectSummary,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CreateProjectDto, UpdateProjectDto } from './projects.dto.js';
import { ProjectsService } from './projects.service.js';

/**
 * Workspace > Project > Document. Projects are organizational only: the ACL
 * boundary stays the workspace, so reads need `viewer`, edits need `editor`
 * and deletion — being destructive and workspace-shaping — needs `admin`.
 */
@ApiTags('projects')
@Controller('v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List projects in a workspace' })
  list(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListProjectsResponse> {
    return this.projects.list(workspaceId);
  }

  @Post()
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Create a project' })
  create(
    @Body() dto: CreateProjectDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateProjectResponse> {
    return this.projects.create(dto, principal?.userId);
  }

  @Get(':id')
  @Access('viewer', 'project')
  @ApiOperation({ summary: 'Project detail' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectSummary> {
    return this.projects.get(id);
  }

  @Patch(':id')
  @Access('editor', 'project')
  @ApiOperation({ summary: 'Rename a project / edit its description' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ProjectSummary> {
    return this.projects.update(id, dto, principal?.userId);
  }

  @Delete(':id')
  @Access('admin', 'project')
  @ApiOperation({ summary: 'Delete an empty project (409 when it still holds documents)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ deleted: true }> {
    return this.projects.remove(id, principal?.userId);
  }
}
