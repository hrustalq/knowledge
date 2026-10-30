import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type {
  CreateMergeRequestResponse,
  CreateMergeRequestThreadResponse,
  DeleteMergeRequestCommentResponse,
  ListMergeRequestsResponse,
  ListMergeRequestThreadsResponse,
  ListSavedFiltersResponse,
  ListWorkspaceMergeRequestsResponse,
  MergeMergeRequestResponse,
  MergeRequestApiChangesResponse,
  MergeRequestCheckInfo,
  MergeRequestDiffResponse,
  MergeRequestThreadResponse,
  PublishBranchResponse,
  SavedFilter,
} from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { MergeRequestsService } from './merge-requests.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { MergeRequestThreadsService } from './merge-request-threads.service.js';
import { SavedFiltersService } from './saved-filters.service.js';
import {
  CreateCommentDto,
  CreateMergeRequestDto,
  CreateThreadDto,
  ListMergeRequestsQueryDto,
  MergeMergeRequestDto,
  PublishBranchDto,
  ResolveThreadDto,
  SetReviewersDto,
  UpdateMergeRequestDto,
} from './dto/merge-requests.dto.js';
import {
  CreateSavedFilterDto,
  ListSavedFiltersQueryDto,
  UpdateSavedFilterDto,
} from './dto/saved-filters.dto.js';
import { OverrideLintCheckDto } from './lint/lint.dto.js';
import { Returns } from '../common/returns.decorator.js';

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
    private readonly savedFilters: SavedFiltersService,
    private readonly permissions: PermissionService,
  ) {}

  @Post('documents/:id/merge-requests')
  @Returns('CreateMergeRequestResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Open a merge request between two branches of a document' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMergeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateMergeRequestResponse> {
    return this.mergeRequests.create(id, dto, principal?.userId);
  }

  @Post('documents/:id/branches/:branchId/publish')
  @Returns('PublishBranchResponse')
  @Access('editor', 'document')
  @ApiOperation({
    summary: 'Publish a working branch onto the default branch (#474)',
    description:
      'Opens a merge request from the branch (or reuses its open one) and merges it at once. When a gate refuses — ' +
      '`protected`, `approvals`, `lint`, `breaking-api`, `draft` — the merge request stays open and `merged` is false. ' +
      '400 when there is nothing to publish; 409 `diverged` (naming the page) when a default head moved past the ' +
      'branch and `onTopOf` does not list it. Publishes every page the branch has revisions on (#636). The guard ' +
      'holds the caller to edit on the branch.',
  })
  publishBranch(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: PublishBranchDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PublishBranchResponse> {
    return this.mergeRequests.publishBranch(id, branchId, dto, principal);
  }

  @Get('documents/:id/merge-requests')
  @Returns('ListMergeRequestsResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List merge requests of a document (newest first)' })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<ListMergeRequestsResponse> {
    return this.mergeRequests.list(id);
  }

  @Get('merge-requests')
  @Returns('ListWorkspaceMergeRequestsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List merge requests across a workspace (filterable, cursor-paginated)' })
  async listWorkspace(@Query() query: ListMergeRequestsQueryDto, @CurrentPrincipal() principal: Principal): Promise<ListWorkspaceMergeRequestsResponse> {
    return this.mergeRequests.listWorkspace(query, await this.permissions.scopeFor(principal, query.workspaceId));
  }

  /**
   * Saved filters: named narrowings of the list above, private to their owner.
   *
   * Declared before `merge-requests/:id` because Nest matches in declaration
   * order and `filters` would otherwise be read as a merge-request id — the
   * same reason `documents/tree` precedes `documents/:id`. The path param is
   * `:filterId`, not `:id`, so the integer never reaches a UUID pipe.
   */
  @Get('merge-requests/filters')
  @Returns('ListSavedFiltersResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List your saved merge-request filters in a workspace' })
  listSavedFilters(
    @Query() query: ListSavedFiltersQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ListSavedFiltersResponse> {
    return this.savedFilters.list(query.workspaceId, principal);
  }

  @Post('merge-requests/filters')
  @Returns('SavedFilter')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Save the current narrowing under a name' })
  createSavedFilter(@Body() dto: CreateSavedFilterDto, @CurrentPrincipal() principal: Principal): Promise<SavedFilter> {
    return this.savedFilters.create(dto, principal);
  }

  @Get('merge-requests/filters/:filterId')
  @Returns('SavedFilter')
  @Access('viewer', 'saved-filter')
  @ApiParam({ name: 'filterId', type: Number })
  @ApiOperation({ summary: 'Restore one saved filter by its number (the `?view=` link target)' })
  getSavedFilter(
    @Param('filterId') filterId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SavedFilter> {
    return this.savedFilters.get(Number(filterId), principal);
  }

  @Patch('merge-requests/filters/:filterId')
  @Returns('SavedFilter')
  @Access('viewer', 'saved-filter')
  @ApiParam({ name: 'filterId', type: Number })
  @ApiOperation({ summary: 'Rename a saved filter, or overwrite it with the current narrowing' })
  updateSavedFilter(
    @Param('filterId') filterId: string,
    @Body() dto: UpdateSavedFilterDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SavedFilter> {
    return this.savedFilters.update(Number(filterId), dto, principal);
  }

  @Delete('merge-requests/filters/:filterId')
  @Access('viewer', 'saved-filter')
  @ApiParam({ name: 'filterId', type: Number })
  @ApiOperation({ summary: 'Delete a saved filter' })
  removeSavedFilter(
    @Param('filterId') filterId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.savedFilters.remove(Number(filterId), principal);
  }

  @Get('merge-requests/:id')
  @Returns('CreateMergeRequestResponse')
  @Access('viewer', 'merge-request')
  @ApiOperation({ summary: 'Get merge request state (heads, merge base, approvals, reviewers)' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CreateMergeRequestResponse> {
    return this.mergeRequests.get(id);
  }

  @Patch('merge-requests/:id')
  @Returns('CreateMergeRequestResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Edit title/description/draft flag (open merge requests only)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMergeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateMergeRequestResponse> {
    return this.mergeRequests.update(id, dto, principal?.userId);
  }

  @Post('merge-requests/:id/reopen')
  @Returns('CreateMergeRequestResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Reopen a closed merge request (merged ones are terminal)' })
  reopen(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<CreateMergeRequestResponse> {
    return this.mergeRequests.reopen(id, principal?.userId);
  }

  @Put('merge-requests/:id/reviewers')
  @Returns('CreateMergeRequestResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Replace the reviewer set (workspace members only; advisory, not a merge gate)' })
  setReviewers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetReviewersDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateMergeRequestResponse> {
    return this.mergeRequests.setReviewers(id, dto.reviewerIds, principal?.userId);
  }

  @Get('merge-requests/:id/diff')
  @Returns('MergeRequestDiffResponse')
  @Access('viewer', 'merge-request')
  @ApiOperation({ summary: 'Merge-base diff of the MR, per changed page the caller may open: text + structural (+ semantic on request)' })
  @ApiQuery({ name: 'semantic', required: false, description: 'Include graph-projection semantic diff (default false)' })
  async diff(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('semantic') semantic?: string,
  ): Promise<MergeRequestDiffResponse> {
    return this.mergeRequests.diff(id, await this.scopeForMr(id, principal), { semantic: semantic === 'true' });
  }

  @Get('merge-requests/:id/api-changes')
  @Returns('MergeRequestApiChangesResponse')
  @Access('viewer', 'merge-request')
  @ApiOperation({
    summary:
      'What a spec merge request does to its API: the classified diff from the merge base, the pages linking ' +
      'each changed operation, the workspace policy and whether a merge would be refused. applicable=false for a page',
  })
  async apiChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MergeRequestApiChangesResponse> {
    return this.mergeRequests.apiChanges(id, await this.scopeForMr(id, principal));
  }

  @Post('merge-requests/:id/breaking-ack')
  @Returns('MergeRequestApiChangesResponse')
  @Access('admin', 'merge-request')
  @ApiOperation({
    summary:
      "Acknowledge the spec's breaking changes at the current source head, which lets a merge through a block " +
      'policy. A later push needs a new acknowledgement',
  })
  async acknowledgeBreaking(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MergeRequestApiChangesResponse> {
    return this.mergeRequests.setBreakingAck(id, true, await this.scopeForMr(id, principal), principal?.userId);
  }

  @Delete('merge-requests/:id/breaking-ack')
  @Returns('MergeRequestApiChangesResponse')
  @Access('admin', 'merge-request')
  @ApiOperation({ summary: 'Withdraw the acknowledgement of breaking API changes' })
  async withdrawBreakingAck(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MergeRequestApiChangesResponse> {
    return this.mergeRequests.setBreakingAck(id, false, await this.scopeForMr(id, principal), principal?.userId);
  }

  @Post('merge-requests/:id/checks/:checkId/override')
  @Access('admin', 'merge-request')
  @ApiOperation({
    summary:
      "Override the style check of the current source head, which lets it through a block policy. A reason is required; " +
      'it is audited and shown in the activity feed. A later push needs its own pass or override',
  })
  overrideLintCheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: OverrideLintCheckDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ check: MergeRequestCheckInfo }> {
    return this.mergeRequests.overrideLintCheck(id, checkId, dto.reason, principal);
  }

  @Post('merge-requests/:id/approve')
  @Returns('CreateMergeRequestResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Approve as the calling principal (MR_REQUIRED_APPROVALS non-author approvals gate the merge)' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<CreateMergeRequestResponse> {
    return this.mergeRequests.approve(id, principal?.userId);
  }

  @Post('merge-requests/:id/merge')
  @Returns('MergeMergeRequestResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({
    summary:
      'Merge (merge-commit or squash); 409 with details.reason draft|approvals|diverged|breaking-api when gated, ' +
      '+ comparison link when the target diverged',
  })
  merge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeMergeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MergeMergeRequestResponse> {
    return this.mergeRequests.merge(id, dto.strategy ?? 'merge-commit', principal);
  }

  @Post('merge-requests/:id/close')
  @Returns('CreateMergeRequestResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Close the merge request without merging' })
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<CreateMergeRequestResponse> {
    return this.mergeRequests.close(id, principal?.userId);
  }

  // --- Review discussions (plan.md §8) ---
  // AclGuard resolves the workspace from :id (the MR); :threadId ownership is
  // checked in the service.

  @Get('merge-requests/:id/threads')
  @Returns('ListMergeRequestThreadsResponse')
  @Access('viewer', 'merge-request')
  @ApiOperation({ summary: 'List review threads with comments (unresolved first)' })
  async listThreads(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ListMergeRequestThreadsResponse> {
    return this.threads.list(id, await this.scopeForMr(id, principal));
  }

  @Post('merge-requests/:id/threads')
  @Returns('CreateMergeRequestThreadResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Start a review thread (optionally anchored to a line/section/entity)' })
  createThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateThreadDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateMergeRequestThreadResponse> {
    return this.threads.createThread(id, dto, principal?.userId);
  }

  @Post('merge-requests/:id/threads/:threadId/comments')
  @Returns('CreateMergeRequestThreadResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Reply to a review thread' })
  reply(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: CreateCommentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateMergeRequestThreadResponse> {
    return this.threads.reply(id, threadId, dto.body, principal?.userId, dto.replyToId);
  }

  @Patch('merge-requests/:id/threads/:threadId/comments/:commentId')
  @Returns('MergeRequestThreadResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: "Edit a review comment (the comment's own author only)" })
  editComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: CreateCommentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MergeRequestThreadResponse> {
    return this.threads.editComment(id, threadId, commentId, dto.body, principal?.userId);
  }

  @Delete('merge-requests/:id/threads/:threadId/comments/:commentId')
  @Returns('DeleteMergeRequestCommentResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({
    summary: "Delete a review comment (the comment's own author only); removes the thread if it was the last one",
  })
  deleteComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeleteMergeRequestCommentResponse> {
    return this.threads.deleteComment(id, threadId, commentId, principal?.userId);
  }

  @Patch('merge-requests/:id/threads/:threadId')
  @Returns('MergeRequestThreadResponse')
  @Access('editor', 'merge-request')
  @ApiOperation({ summary: 'Resolve or unresolve a review thread' })
  resolveThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body() dto: ResolveThreadDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MergeRequestThreadResponse> {
    return this.threads.setResolved(id, threadId, dto.resolved, principal?.userId);
  }

  /** The caller's scope in the merge request's workspace, for reads that list pages. */
  private async scopeForMr(id: string, principal: Principal) {
    const { documentId } = await this.mergeRequests.documentOf(id);
    return this.permissions.scopeForDocument(principal, documentId);
  }
}
