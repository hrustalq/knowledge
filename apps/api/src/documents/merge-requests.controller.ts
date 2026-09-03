import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { MergeRequestsService } from './merge-requests.service.js';
import { MergeRequestThreadsService } from './merge-request-threads.service.js';
import {
  CreateCommentDto,
  CreateMergeRequestDto,
  CreateThreadDto,
  ListMergeRequestsQueryDto,
  MergeMergeRequestDto,
  ResolveThreadDto,
  SetReviewersDto,
  UpdateMergeRequestDto,
} from './dto/merge-requests.dto.js';

/**
 * Merge-request surface (plan.md §7/§8): nested under the document for
 * create/list, top-level /v1/merge-requests/:id for everything else —
 * mirroring GitLab's URL shape.
 */
@ApiTags('merge-requests')
@Controller('v1')
export class MergeRequestsController {
  constructor(
    private readonly mergeRequests: MergeRequestsService,
    private readonly threads: MergeRequestThreadsService,
  ) {}

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

  @Get('merge-requests')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List merge requests across a workspace (filterable, cursor-paginated)' })
  listWorkspace(@Query() query: ListMergeRequestsQueryDto) {
    return this.mergeRequests.listWorkspace(query);
  }

  @Get('merge-requests/:id')
  @Access('viewer', 'merge-request')
  @ApiOperation({ summary: 'Get merge request state (heads, merge base, approvals, reviewers)' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.mergeRequests.get(id);
  }

  @Patch('merge-requests/:id')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Edit title/description/draft flag (open merge requests only)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMergeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mergeRequests.update(id, dto, principal?.userId);
  }

  @Post('merge-requests/:id/reopen')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Reopen a closed merge request (merged ones are terminal)' })
  reopen(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal) {
    return this.mergeRequests.reopen(id, principal?.userId);
  }

  @Put('merge-requests/:id/reviewers')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Replace the reviewer set (workspace members only; advisory, not a merge gate)' })
  setReviewers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetReviewersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mergeRequests.setReviewers(id, dto.reviewerIds, principal?.userId);
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
  @ApiOperation({ summary: 'Approve as the calling principal (MR_REQUIRED_APPROVALS non-author approvals gate the merge)' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal) {
    return this.mergeRequests.approve(id, principal?.userId);
  }

  @Post('merge-requests/:id/merge')
  @Access('editor', 'merge-request')
  @ApiOperation({
    summary:
      'Merge (merge-commit or squash); 409 with details.reason draft|approvals|diverged when gated, ' +
      '+ comparison link when the target diverged',
  })
  merge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeMergeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mergeRequests.merge(id, dto.strategy ?? 'merge-commit', principal);
  }

  @Post('merge-requests/:id/close')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Close the merge request without merging' })
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal) {
    return this.mergeRequests.close(id, principal?.userId);
  }

  // --- Review discussions (plan.md §8) ---
  // AclGuard resolves the workspace from :id (the MR); :threadId ownership is
  // checked in the service.

  @Get('merge-requests/:id/threads')
  @Access('viewer', 'merge-request')
  @ApiOperation({ summary: 'List review threads with comments (unresolved first)' })
  listThreads(@Param('id', ParseUUIDPipe) id: string) {
    return this.threads.list(id);
  }

  @Post('merge-requests/:id/threads')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Start a review thread (optionally anchored to a line/section/entity)' })
  createThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateThreadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.createThread(id, dto, principal?.userId);
  }

  @Post('merge-requests/:id/threads/:threadId/comments')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Reply to a review thread' })
  reply(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: CreateCommentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.reply(id, threadId, dto.body, principal?.userId);
  }

  @Patch('merge-requests/:id/threads/:threadId')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Resolve or unresolve a review thread' })
  resolveThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: ResolveThreadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.threads.setResolved(id, threadId, dto.resolved, principal?.userId);
  }
}
