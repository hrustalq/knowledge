import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access } from '../auth/access.decorator.js';
import { ActivityService } from './activity.service.js';

@ApiTags('activity')
@Controller('v1/activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Workspace activity feed, newest first (docs/features/10)' })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'documentId', required: false })
  @ApiQuery({ name: 'subjectId', required: false, description: 'Secondary subject id — e.g. a merge request id, for its own timeline' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  list(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('documentId') documentId?: string,
    @Query('subjectId') subjectId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.activity.list(workspaceId, {
      documentId: documentId || undefined,
      subjectId: subjectId || undefined,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor || undefined,
    });
  }
}
