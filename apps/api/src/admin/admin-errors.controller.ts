import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminErrorResponse, AdminErrorsResponse } from '@knowledge/contracts';
import { PlatformAdmin } from '../auth/access.decorator.js';
import { CachePolicy } from '../common/http-cache.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe } from '../common/validation.js';
import { AdminErrorsQueryDto } from './admin-errors.dto.js';
import { AdminErrorsService } from './admin-errors.service.js';

/** The admin console's errors list (#1240), over ops_events. Read-only. */
@ApiTags('admin')
@PlatformAdmin()
@Controller('v1/admin/errors')
export class AdminErrorsController {
  constructor(private readonly errors: AdminErrorsService) {}

  @Get()
  @CachePolicy('no-store')
  @Returns('AdminErrorsResponse')
  @ApiOperation({ summary: 'Error groups (derived fingerprint) in a period, newest first, with count, first and last seen (platform admin)' })
  list(@Query() q: AdminErrorsQueryDto): Promise<AdminErrorsResponse> {
    return this.errors.list({ hours: q.hours ?? 24, processes: q.process, workspaceIds: q.workspaceId, text: q.q?.trim() || undefined, cursor: q.cursor });
  }

  @Get(':id')
  @CachePolicy('no-store')
  @Returns('AdminErrorResponse')
  @ApiOperation({ summary: 'One error event with its trace id, context and stack, plus its group (platform admin)' })
  get(@Param('id', ParseUuidPipe) id: string): Promise<AdminErrorResponse> {
    return this.errors.get(id);
  }
}
