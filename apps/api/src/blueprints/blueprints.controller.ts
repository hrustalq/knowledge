import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BlueprintEntry, BlueprintInterviewRound, DeriveBlueprintResponse, GenerateBlueprintResponse, ListBlueprintsResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe } from '../common/validation.js';
import { BlueprintDeriveService } from './blueprint-derive.service.js';
import { BlueprintGenerateService } from './blueprint-generate.service.js';
import { parseBlueprint } from './blueprint.schema.js';
import { BlueprintsService } from './blueprints.service.js';
import { CreateBlueprintDto, DeriveBlueprintDto, GenerateBlueprintDto, ListBlueprintsQueryDto, UpdateBlueprintDto } from './blueprints.dto.js';

/**
 * The blueprints a project can start from (#716): built-ins (code, both
 * languages, since the skeleton language is picked last), the workspace's
 * overrides of them, and its saved ones.
 *
 * Writes are `admin`, the bar for a workspace-wide template: a blueprint
 * changes what every editor in the workspace is offered. Derive is `editor`
 * on the workspace the project is for — it writes nothing — and checks the
 * source project under the caller's scope in the source's own workspace.
 */
@ApiTags('projects')
@Controller('v1/blueprints')
export class BlueprintsController {
  constructor(
    private readonly blueprints: BlueprintsService,
    private readonly deriver: BlueprintDeriveService,
    private readonly generator: BlueprintGenerateService,
  ) {}

  // Literal segments before `:id` — Nest matches in declaration order.

  @Get()
  @Returns('ListBlueprintsResponse')
  @Access('viewer', 'query')
  @ApiOperation({
    summary: 'Blueprints a project can be scaffolded from: built-ins with overrides applied, then saved ones',
    description: 'Hidden built-ins and switched-off saved blueprints only with `includeDisabled`.',
  })
  list(@Query() query: ListBlueprintsQueryDto): Promise<ListBlueprintsResponse> {
    return this.blueprints.list(query.workspaceId, query.includeDisabled);
  }

  @Post('derive')
  @Returns('DeriveBlueprintResponse')
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Read a blueprint off an existing project: titles and headings only, never page text',
    description:
      'The source project may be in any workspace the caller belongs to and is read under their access there. ' +
      'Glossary terms are offered only from the same workspace. With `assistant` on, the scaffolder drafts a ' +
      'styleguide and page guidance; otherwise, or when that call fails, `drafted` is false.',
  })
  derive(@Body() dto: DeriveBlueprintDto, @CurrentPrincipal() principal: Principal): Promise<DeriveBlueprintResponse> {
    return this.deriver.derive(dto.workspaceId, dto.projectId, principal);
  }

  @Post('generate')
  @Feature('assistant')
  @Returns('GenerateBlueprintResponse')
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Draft a blueprint from a description (Describe it): the scaffolder, with read-only tree and search',
    description:
      'Writes nothing. The scaffolder may list the workspace tree and search it, each call under the caller\'s ' +
      'access, and may adapt an optional starting blueprint. Its answer passes the same schema scaffold uses; ' +
      'unknown template refs and malformed pages are dropped. 422 when nothing usable came back. With `rounds` ' +
      '(#731) it interviews first: `status: asking` carries the next round of questions, the outline so far and ' +
      'candidate glossary terms; `draft`, the round cap or the model running out of questions ends it with `done`.',
  })
  generate(@Body() dto: GenerateBlueprintDto, @CurrentPrincipal() principal: Principal): Promise<GenerateBlueprintResponse> {
    const start = dto.blueprint ? parseBlueprint(dto.blueprint) : null;
    // The DTO cannot name the contracts type; every question is re-read by `readRound` before the model sees it.
    const interview = dto.rounds ? { rounds: dto.rounds as unknown as BlueprintInterviewRound[], draft: dto.draft === true } : undefined;
    return this.generator.generate(dto.workspaceId, dto.brief, start, principal, interview);
  }

  @Post()
  @Returns('BlueprintEntry')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Save a blueprint, or customise or hide a built-in (`builtInKey`)' })
  create(@Body() dto: CreateBlueprintDto, @CurrentPrincipal() principal: Principal): Promise<BlueprintEntry> {
    return this.blueprints.create(dto.workspaceId, dto, principal.userId);
  }

  @Patch(':id')
  @Returns('BlueprintEntry')
  @Access('admin', 'blueprint')
  @ApiOperation({ summary: 'Change a saved blueprint or an override; a changed blueprint appends a version' })
  update(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateBlueprintDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BlueprintEntry> {
    return this.blueprints.update(id, dto, principal.userId);
  }

  @Delete(':id')
  @Access('admin', 'blueprint')
  @ApiOperation({ summary: 'Delete a saved blueprint, or reset a built-in by deleting its override' })
  async remove(@Param('id', ParseUuidPipe) id: string): Promise<{ ok: true }> {
    await this.blueprints.remove(id);
    return { ok: true };
  }
}
