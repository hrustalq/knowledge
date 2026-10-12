import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ListTemplatesResponse,
  ListTemplateVersionsResponse,
  RenderTemplateResponse,
  TemplateDetail,
} from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { TemplatesService } from './templates.service.js';
import {
  BuiltInTemplateQueryDto,
  CreateTemplateDto,
  ListTemplatesQueryDto,
  RenderTemplateDto,
  TemplateVersionQueryDto,
  UpdateTemplateDto,
} from './templates.dto.js';

/**
 * Page templates (issue #69).
 *
 * Reads are `viewer`. Writes are `editor` at the guard, and **`admin`** once
 * the row turns out to be workspace-wide or a built-in override: those change
 * what every project in the workspace is offered, the same bar as a workflow
 * definition. That half depends on the body or the row, which `@Access`
 * cannot see, so it is an explicit `requireRole` here — after the guard has
 * already proved membership.
 *
 * Every `:id` route resolves its workspace from the row (`template` source),
 * so a template id from another tenant is a 403 before the handler runs.
 */
@ApiTags('templates')
@Controller('v1/templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly access: AccessService,
  ) {}

  // Literal segments before `:id` — Nest matches in declaration order.

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({
    summary: 'The template gallery: built-ins (in the caller’s language) merged with the workspace’s own',
    description:
      'With `projectId`, workspace-wide templates plus that project’s. Archived templates and hidden ' +
      'built-ins only with `includeArchived`.',
  })
  list(@Query() query: ListTemplatesQueryDto): Promise<ListTemplatesResponse> {
    return this.templates.list(query);
  }

  @Get('built-in/:key')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'A built-in template as this workspace sees it — its override when it has one' })
  getBuiltIn(@Param('key') key: string, @Query() query: BuiltInTemplateQueryDto): Promise<TemplateDetail> {
    return this.templates.getBuiltIn(query.workspaceId, key, query.version);
  }

  @Post('render')
  @Access('viewer', 'body')
  @ReadKeyOk()
  @ApiOperation({
    summary: 'Fill a template in without writing anything',
    description:
      'Substitutes system and declared placeholders and returns the title, body and frontmatter a page would ' +
      'start from. Undeclared and escaped `{{…}}` stay literal. 400 `details.missing` when a required value is absent.',
  })
  render(@Body() dto: RenderTemplateDto, @CurrentPrincipal() principal: Principal): Promise<RenderTemplateResponse> {
    return this.templates.render(dto, { id: principal.userId, name: principal.displayName });
  }

  @Post()
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Create a template, or override a built-in (`builtInKey`)',
    description: 'A project template needs `editor`; a workspace-wide template or a built-in override needs `admin`.',
  })
  async create(@Body() dto: CreateTemplateDto, @CurrentPrincipal() principal: Principal): Promise<TemplateDetail> {
    if (!dto.projectId || dto.builtInKey !== undefined) {
      await this.access.requireRole(principal, dto.workspaceId, 'admin');
    }
    return this.templates.create(dto, principal.userId);
  }

  @Get(':id')
  @Access('viewer', 'template')
  @ApiOperation({ summary: 'A template with its source and parsed metadata (current version unless `version` is given)' })
  get(@Param('id', ParseUUIDPipe) id: string, @Query() query: TemplateVersionQueryDto): Promise<TemplateDetail> {
    return this.templates.get(id, query.version);
  }

  @Get(':id/versions')
  @Access('viewer', 'template')
  @ApiOperation({ summary: 'Version history, newest first' })
  versions(@Param('id', ParseUUIDPipe) id: string): Promise<ListTemplateVersionsResponse> {
    return this.templates.listVersions(id);
  }

  @Get(':id/versions/:version')
  @Access('viewer', 'template')
  @ApiOperation({ summary: 'One past version' })
  version(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<TemplateDetail> {
    return this.templates.get(id, version);
  }

  @Patch(':id')
  @Access('editor', 'template')
  @ApiOperation({ summary: 'Update a template; a changed source appends a version, a rename does not' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TemplateDetail> {
    await this.requireScopeRole(id, principal);
    return this.templates.update(id, dto, principal.userId);
  }

  @Post(':id/archive')
  @Access('editor', 'template')
  @ApiOperation({ summary: 'Archive a custom template: hidden from the gallery, still resolvable by its pages' })
  async archive(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<TemplateDetail> {
    await this.requireScopeRole(id, principal);
    return this.templates.setArchived(id, true, principal.userId);
  }

  @Post(':id/unarchive')
  @Access('editor', 'template')
  @ApiOperation({ summary: 'Bring an archived template back into the gallery' })
  async unarchive(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<TemplateDetail> {
    await this.requireScopeRole(id, principal);
    return this.templates.setArchived(id, false, principal.userId);
  }

  @Delete(':id')
  @Access('admin', 'template')
  @ApiOperation({
    summary: 'Reset a built-in to its shipped default by deleting the workspace’s override',
    description: 'Only built-in overrides can be deleted. A custom template is archived instead: pages record it.',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<{ ok: true }> {
    await this.templates.remove(id, principal.userId);
    return { ok: true };
  }

  /** A workspace-wide row or a built-in override is `admin` to change; a project row is `editor` (the guard). */
  private async requireScopeRole(id: string, principal: Principal): Promise<void> {
    const scope = await this.templates.scopeOf(id);
    if (!scope.projectId || scope.builtInKey) {
      await this.access.requireRole(principal, scope.workspaceId, 'admin');
    }
  }
}
