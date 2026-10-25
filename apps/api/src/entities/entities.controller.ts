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
import { normalizeEntityKey } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { EntityAliasService } from '../graph/entity-alias.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EntitiesService } from './entities.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { withAsOf } from '../graph/temporal.js';
import { ApiAsOfQuery } from '../temporal/temporal.dto.js';
import { TemporalResolverService } from '../temporal/temporal-resolver.service.js';
import { CreateEntityAliasDto, ImpactAnalysisDto } from './dto/entities.dto.js';
import { t } from '../i18n/t.js';
import { Returns } from '../common/returns.decorator.js';
import type {
  EntityNeighborsResponse,
  ImpactAnalysisResponse,
  ListEntitiesResponse,
  TraceRelationResponse,
} from '@knowledge/contracts';

@ApiTags('entities')
@Controller('v1/entities')
export class EntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly aliases: EntityAliasService,
    private readonly graph: GraphService,
    private readonly permissions: PermissionService,
    private readonly temporal: TemporalResolverService,
  ) {}

  @Get()
  @Returns('ListEntitiesResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List workspace entities with relation degree' })
  @ApiQuery({ name: 'type', required: false, description: 'Entity type, e.g. "tag"' })
  @ApiQuery({ name: 'q', required: false, description: 'Case-insensitive substring of the name' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max entities to return (1-200)' })
  @ApiAsOfQuery()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('asOf') asOf?: string,
    @Query('knownAt') knownAt?: string,
  ): Promise<ListEntitiesResponse> {
    const n = limit ? Number(limit) : Number.NaN;
    const at = await this.temporal.resolve(workspaceId, asOf, knownAt);
    const res = await this.entities.listEntities(
      await this.permissions.scopeFor(principal, workspaceId),
      { type, q, limit: Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : undefined },
      at,
    );
    return withAsOf(res, at);
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
    // Answer in the spelling actually stored, not the one that was sent. The
    // whole point of this endpoint is that the two differ, so echoing the input
    // back would hide the only thing the caller needs to see.
    const alias = normalizeEntityKey(dto.alias);
    const canonicalKey = normalizeEntityKey(dto.canonicalKey);

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
        message: t('error.entityAlias.wouldChain', { alias, canonicalKey }),
        alias,
        canonicalKey,
      });
    }
    const edgesMoved = await this.graph.mergeEntityKey(dto.workspaceId, alias, canonicalKey);
    return { alias, canonicalKey, edgesMoved };
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
  @Returns('TraceRelationResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Shortest relation path between two entities (knowledge.trace_relation)' })
  @ApiQuery({ name: 'maxDepth', required: false })
  @ApiAsOfQuery()
  async trace(
    @CurrentPrincipal() principal: Principal,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('maxDepth') maxDepth?: string,
    @Query('asOf') asOf?: string,
    @Query('knownAt') knownAt?: string,
  ): Promise<TraceRelationResponse> {
    const at = await this.temporal.resolve(workspaceId, asOf, knownAt);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    return withAsOf(await this.entities.trace(scope, from, to, maxDepth ? Number(maxDepth) : undefined, at), at);
  }

  @Get(':key/neighbors')
  @Returns('EntityNeighborsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Entity neighborhood: edges + entities within N hops (knowledge.find_relations)' })
  @ApiQuery({ name: 'depth', required: false })
  @ApiQuery({ name: 'types', required: false, description: 'Comma-separated relation types' })
  @ApiAsOfQuery()
  async neighbors(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('depth') depth?: string,
    @Query('types') types?: string,
    @Query('asOf') asOf?: string,
    @Query('knownAt') knownAt?: string,
  ): Promise<EntityNeighborsResponse> {
    const at = await this.temporal.resolve(workspaceId, asOf, knownAt);
    const res = await this.entities.neighbors(
      await this.permissions.scopeFor(principal, workspaceId),
      key,
      depth ? Number(depth) : undefined,
      types ? types.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      at,
    );
    return withAsOf(res, at);
  }

  @Post(':key/impact-analysis')
  @Returns('ImpactAnalysisResponse')
  @HttpCode(200)
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Transitive impact of changing an entity (knowledge.impact_analysis)' })
  async impact(@Param('key') key: string, @Body() dto: ImpactAnalysisDto, @CurrentPrincipal() principal: Principal): Promise<ImpactAnalysisResponse> {
    const at = await this.temporal.resolve(dto.workspaceId, dto.asOf, dto.knownAt);
    const scope = await this.permissions.scopeFor(principal, dto.workspaceId);
    return withAsOf(await this.entities.impactAnalysis(scope, key, dto.direction, dto.maxDepth, at), at);
  }
}
