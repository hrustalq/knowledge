import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { EntityAliasService } from '../graph/entity-alias.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EntitiesService } from './entities.service.js';
import { CreateEntityAliasDto, ImpactAnalysisDto } from './dto/entities.dto.js';
import { t } from '../i18n/t.js';

@ApiTags('entities')
@Controller('v1/entities')
export class EntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly aliases: EntityAliasService,
    private readonly graph: GraphService,
  ) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List workspace entities with relation degree' })
  @ApiQuery({ name: 'type', required: false, description: 'Entity type, e.g. "tag"' })
  @ApiQuery({ name: 'q', required: false, description: 'Case-insensitive substring of the name' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max entities to return (1-200)' })
  list(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number(limit) : Number.NaN;
    return this.entities.listEntities(workspaceId, {
      type,
      q,
      limit: Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : undefined,
    });
  }

  // NB: declared before :key routes so "aliases" is not captured as a key.
  @Get('aliases')
  @Access('viewer', 'query')
  @ApiOperation({ summary: "A workspace's canonical entity-key aliases (ru ↔ en)" })
  listAliases(@Query('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.aliases.list(workspaceId);
  }

  @Post('aliases')
  @HttpCode(200)
  @Access('editor', 'body')
  @ApiOperation({
    summary: 'Declare one entity key to mean another, folding the edges that already exist',
  })
  async createAlias(@Body() dto: CreateEntityAliasDto, @CurrentPrincipal() principal: Principal) {
    const created = await this.aliases.create({
      workspaceId: dto.workspaceId,
      alias: dto.alias,
      canonicalKey: dto.canonicalKey,
      createdBy: principal.userId,
    });
    if (!created) {
      // The guard refuses anything that would make resolution more than one
      // hop. Saying so beats reporting a success that resolved nothing.
      throw new ConflictException({
        statusCode: 409,
        message: t('error.entityAlias.wouldChain'),
        alias: dto.alias,
        canonicalKey: dto.canonicalKey,
      });
    }
    const moved = await this.graph.mergeEntityKey(dto.workspaceId, dto.alias, dto.canonicalKey);
    return { alias: dto.alias, canonicalKey: dto.canonicalKey, edgesMoved: moved };
  }

  @Delete('aliases/:alias')
  @HttpCode(204)
  @Access('editor', 'query')
  @ApiOperation({ summary: 'Retire an alias. Edges already folded onto the canonical key stay there.' })
  removeAlias(@Param('alias') alias: string, @Query('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.aliases.remove(workspaceId, alias);
  }

  // NB: declared before :key routes so "trace" is not captured as a key.
  @Get('trace')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Shortest relation path between two entities (knowledge.trace_relation)' })
  @ApiQuery({ name: 'maxDepth', required: false })
  trace(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('maxDepth') maxDepth?: string,
  ) {
    return this.entities.trace(workspaceId, from, to, maxDepth ? Number(maxDepth) : undefined);
  }

  @Get(':key/neighbors')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Entity neighborhood: edges + entities within N hops (knowledge.find_relations)' })
  @ApiQuery({ name: 'depth', required: false })
  @ApiQuery({ name: 'types', required: false, description: 'Comma-separated relation types' })
  neighbors(
    @Param('key') key: string,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('depth') depth?: string,
    @Query('types') types?: string,
  ) {
    return this.entities.neighbors(
      workspaceId,
      key,
      depth ? Number(depth) : undefined,
      types ? types.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    );
  }

  @Post(':key/impact-analysis')
  @HttpCode(200)
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Transitive impact of changing an entity (knowledge.impact_analysis)' })
  impact(@Param('key') key: string, @Body() dto: ImpactAnalysisDto) {
    return this.entities.impactAnalysis(dto.workspaceId, key, dto.direction, dto.maxDepth);
  }
}
