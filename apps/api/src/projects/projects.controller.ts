import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  ProjectDeletionPreview,
  ProjectOverviewResponse,
  ProjectSummary,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import {
  CreateProjectDto,
  DeleteProjectQueryDto,
  DeletionPreviewQueryDto,
  ListProjectsQueryDto,
  UpdateProjectDto,
} from './projects.dto.js';
import { ProjectsService } from './projects.service.js';
import { ProjectOverviewService } from './project-overview.service.js';
import { ProjectCascadeService } from './project-cascade.service.js';

/**
 * Workspace > Project > Document. Projects are organizational only: the ACL
 * boundary stays the workspace, so reads need `viewer`, edits need `editor`
 * and deletion — being destructive and workspace-shaping — needs `admin`.
 */
@ApiTags('projects')
@Controller('v1/projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly overviewService: ProjectOverviewService,
    private readonly cascadeService: ProjectCascadeService,
  ) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List projects in a workspace (searchable; cursor-paginated when limit is given)' })
  list(@Query() query: ListProjectsQueryDto): Promise<ListProjectsResponse> {
    return this.projects.list(query);
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

  /**
   * Everything the project page reads (docs/features/24) — counts, derived
   * contributors, recently updated pages.
   *
   * Declared after `:id` but on a longer path, so Nest's declaration-order
   * matching is not a hazard here the way it is for a bare literal segment.
   */
  @Get(':id/overview')
  @Access('viewer', 'project')
  @ApiOperation({ summary: 'Project overview: counts, contributors, recent pages' })
  overview(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectOverviewResponse> {
    return this.overviewService.get(id);
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

  /**
   * What deleting this project would move, so the confirmation can name it.
   *
   * `admin` — the same role as the delete it previews. A preview that a viewer
   * could read would be a way to enumerate a workspace's shape through a route
   * nobody thinks of as a read.
   *
   * Declared under `:id` on a longer path, exactly as `:id/overview` is, so
   * Nest's declaration-order matching is not a hazard the way a bare literal
   * segment would be.
   */
  @Get(':id/deletion-preview')
  @Access('admin', 'project')
  @ApiOperation({
    summary: 'What deleting this project would relocate (pass ?target= for glossary conflicts)',
  })
  deletionPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeletionPreviewQueryDto,
  ): Promise<ProjectDeletionPreview> {
    return this.projects.deletionPreview(id, {
      target: query.target,
      cascadeCounts: (projectId: string) => this.cascadeService.preview(projectId),
    });
  }

  /**
   * Two ways out, and the caller has to pick one.
   *
   * `mode=move` (the default) is move-then-delete: `moveContentsTo` names the
   * sibling project the contents are reassigned to, and is required whenever
   * this one holds anything (409 `reason:'not-empty'` otherwise, carrying the
   * full holding). `mode=cascade` destroys them instead — the only path in the
   * product that deletes a page — and needs `confirm` to equal the project's
   * name.
   *
   * The teardown is handed in as a function rather than reached from
   * `ProjectsService`, which lives in the worker-facing core module and must
   * not gain storage, graph or fulltext dependencies.
   */
  @Delete(':id')
  @Access('admin', 'project')
  @ApiOperation({
    summary: 'Delete a project: move its contents to another, or cascade-delete them',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteProjectQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeleteProjectResponse> {
    return this.projects.remove(id, principal?.userId, {
      moveContentsTo: query.moveContentsTo,
      confirm: query.confirm,
      ...(query.mode === 'cascade'
        ? { cascade: (projectId: string, workspaceId: string) => this.cascadeService.cascade(projectId, workspaceId) }
        : {}),
    });
  }
}
