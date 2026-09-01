import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
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
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Open a merge request between two branches of a document' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMergeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mergeRequests.create(id, dto, principal?.userId);
  }

  @Get('documents/:id/merge-requests')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List merge requests of a document (newest first)' })
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.list(id);
  }

  @Get('merge-requests/:id')
  @Access('viewer', 'merge-request')
  @ApiOperation({ summary: 'Get merge request state (heads, merge base, approvals)' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.get(id);
  }

  @Get('merge-requests/:id/diff')
  @Access('viewer', 'merge-request')
  @ApiOperation({ summary: 'Merge-base diff of the MR: text + structural (+ semantic on request)' })
  @ApiQuery({ name: 'semantic', required: false, description: 'Include graph-projection semantic diff (default false)' })
  diff(@Param('id', ParseUUIDPipe) id: string, @Query('semantic') semantic?: string) {
    return this.mergeRequests.diff(id, { semantic: semantic === 'true' });
  }

  @Post('merge-requests/:id/approve')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Approve the merge request as the calling principal (recorded; not yet required to merge)' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal) {
    return this.mergeRequests.approve(id, principal?.userId);
  }

  @Post('merge-requests/:id/merge')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Merge (merge-commit or squash); 409 + comparison link when the target diverged' })
  merge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeMergeRequestDto) {
    return this.mergeRequests.merge(id, dto.strategy ?? 'merge-commit');
  }

  @Post('merge-requests/:id/close')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Close the merge request without merging' })
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.close(id);
  }
}
