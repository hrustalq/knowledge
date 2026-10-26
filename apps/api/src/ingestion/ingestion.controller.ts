import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { Access } from '../auth/access.decorator.js';
import { IngestionAdminService } from './ingestion-admin.service.js';
import { Returns } from '../common/returns.decorator.js';
import type {
  IngestionJobInfo,
  ReindexResponse,
  StaleReportResponse,
} from '@knowledge/contracts';

export class ReindexDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Restrict to one document' })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

/** Phase 5 ingestion surface (plan.md §7): job status, staleness, forced reindex. */
@ApiTags('ingestion')
@Controller('v1/ingestion')
export class IngestionController {
  constructor(private readonly admin: IngestionAdminService) {}

  @Get('jobs/:id')
  @Returns('IngestionJobInfo')
  @Access('viewer', 'job')
  @ApiOperation({ summary: 'Ingestion job status (poll after finalize)' })
  getJob(@Param('id', ParseUUIDPipe) id: string): Promise<IngestionJobInfo> {
    return this.admin.getJob(id);
  }

  @Get('stale')
  @Returns('StaleReportResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Staleness report: embedding drift, stuck and failed jobs (Phase 5)' })
  stale(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<StaleReportResponse> {
    return this.admin.staleReport(workspaceId);
  }

  @Post('reindex')
  @Returns('ReindexResponse')
  @HttpCode(202)
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Force reindex of branch-head revisions (workspace or single document)' })
  reindex(@Body() dto: ReindexDto): Promise<ReindexResponse> {
    return this.admin.reindex(dto.workspaceId, dto.documentId);
  }
}
