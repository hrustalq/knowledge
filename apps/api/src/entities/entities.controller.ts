import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access } from '../auth/access.decorator.js';
import { EntitiesService } from './entities.service.js';
import { ImpactAnalysisDto } from './dto/entities.dto.js';

@ApiTags('entities')
@Controller('v1/entities')
export class EntitiesController {
  constructor(private readonly entities: EntitiesService) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List workspace entities with relation degree' })
  list(@Query('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.entities.listEntities(workspaceId);
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
