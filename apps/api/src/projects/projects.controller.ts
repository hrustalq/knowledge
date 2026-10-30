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
  ProjectGitResponse,
  ProjectOverviewResponse,
  ProjectSummary,
} from '@knowledge/contracts';
import { ConfigService } from '@nestjs/config';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Env } from '../config/env.js';
import type { Principal } from '../auth/principal.js';
import {
  CreateProjectDto,
  DeleteProjectQueryDto,
  DeletionPreviewQueryDto,
  ListProjectsQueryDto,
  UpdateProjectDto,
} from './projects.dto.js';
import { ProjectsService } from './projects.service.js';
import { AccessService } from '../auth/access.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ProjectOverviewService } from './project-overview.service.js';
import { ProjectCascadeService } from './project-cascade.service.js';
import { Returns } from '../common/returns.decorator.js';

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
    private readonly permissions: PermissionService,
    private readonly access: AccessService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private workspaceOf(projectId: string): Promise<string> {
    return this.access.workspaceOfProject(projectId);
  }

  @Get()
  @Returns('ListProjectsResponse')
  // Guests too: the roster is filtered to projects they reach (#76).
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: 'List projects in a workspace (searchable; cursor-paginated when limit is given)' })
  async list(@Query() query: ListProjectsQueryDto, @CurrentPrincipal() principal: Principal): Promise<ListProjectsResponse> {
    return this.projects.list(query, await this.permissions.scopeFor(principal, query.workspaceId));
  }

  @Post()
  @Returns('CreateProjectResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Create a project' })
  create(
    @Body() dto: CreateProjectDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateProjectResponse> {
    return this.projects.create(dto, principal?.userId);
  }

  @Get(':id')
  @Returns('ProjectSummary')
  @Access('viewer', 'project')
  @ApiOperation({ summary: 'Project detail' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<ProjectSummary> {
    return this.projects.get(id, await this.permissions.scopeFor(principal, await this.workspaceOf(id)));
  }

  /**
   * Everything the project page reads (docs/features/24) — counts, derived
   * contributors, recently updated pages.
   *
   * Declared after `:id` but on a longer path, so Nest's declaration-order
   * matching is not a hazard here the way it is for a bare literal segment.
   */
  @Get(':id/overview')
  @Returns('ProjectOverviewResponse')
  @Access('viewer', 'project')
  @ApiOperation({ summary: 'Project overview: counts, contributors, recent pages' })
  async overview(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<ProjectOverviewResponse> {
    return this.overviewService.get(id, await this.permissions.scopeFor(principal, await this.workspaceOf(id)));
  }

  /**
   * Where to clone this project from (#636): the web's Clone button. The URL is
   * the web origin's, as SKILL.md writes it, because Caddy routes `/git/*` there.
   * No `guests` opt-in: the git remote refuses guests in v1 (docs/features/71).
   */
  @Get(':id/git')
  @Returns('ProjectGitResponse')
  @Access('viewer', 'project')
  @Feature('git')
  @ApiOperation({ summary: "A project's git clone URL (#636); url is null while the git remote is off" })
  async git(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectGitResponse> {
    if (!this.config.get('GIT_REMOTE_ENABLED', { infer: true })) return { url: null };
    const web = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return { url: `${web}/git/${await this.workspaceOf(id)}/${id}.git` };
  }

  @Patch(':id')
  @Returns('ProjectSummary')
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
  @Returns('ProjectDeletionPreview')
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
  @Returns('DeleteProjectResponse')
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
