import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MergeRequestsService } from './merge-requests.service.js';
import { CreateMergeRequestDto, MergeMergeRequestDto } from './dto/merge-requests.dto.js';

/**
 * Merge-request surface (plan.md §7/§8): nested under the document for
 * create/list, top-level /v1/merge-requests/:id for everything else —
 * mirroring GitLab's URL shape.
 */
@ApiTags('merge-requests')
@Controller('v1')
export class MergeRequestsController {
  constructor(private readonly mergeRequests: MergeRequestsService) {}

  @Post('documents/:id/merge-requests')
  @ApiOperation({ summary: 'Open a merge request between two branches of a document' })
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateMergeRequestDto) {
    return this.mergeRequests.create(id, dto);
  }

  @Get('documents/:id/merge-requests')
  @ApiOperation({ summary: 'List merge requests of a document (newest first)' })
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.list(id);
  }

  @Get('merge-requests/:id')
  @ApiOperation({ summary: 'Get merge request state (heads, merge base, approvals)' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.get(id);
  }

  @Get('merge-requests/:id/diff')
  @ApiOperation({ summary: 'Merge-base diff of the MR: text + structural (+ semantic on request)' })
  @ApiQuery({ name: 'semantic', required: false, description: 'Include graph-projection semantic diff (default false)' })
  diff(@Param('id', ParseUUIDPipe) id: string, @Query('semantic') semantic?: string) {
    return this.mergeRequests.diff(id, { semantic: semantic === 'true' });
  }

  @Post('merge-requests/:id/approve')
  @ApiOperation({ summary: 'Approve the merge request (recorded; not yet enforced — auth is a Phase 5 stub)' })
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.approve(id);
  }

  @Post('merge-requests/:id/merge')
  @ApiOperation({ summary: 'Merge (merge-commit or squash); 409 + comparison link when the target diverged' })
  merge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeMergeRequestDto) {
    return this.mergeRequests.merge(id, dto.strategy ?? 'merge-commit');
  }

  @Post('merge-requests/:id/close')
  @ApiOperation({ summary: 'Close the merge request without merging' })
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.close(id);
  }
}
