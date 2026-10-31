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
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateWorkspaceResponse,
  DeleteWorkspaceResponse,
  ListWorkspaceCandidatesResponse,
  ListWorkspaceMembersResponse,
  ListWorkspacesResponse,
  UpdateWorkspaceResponse,
  WorkspaceDeletionPreviewResponse,
  WorkspaceFeaturesResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { FeaturesService } from '../auth/features.service.js';
import {
  AddMemberDto,
  CreateWorkspaceDto,
  DeleteWorkspaceQueryDto,
  ListCandidatesQueryDto,
  UpdateMemberDto,
  UpdateWorkspaceDto,
  UpdateWorkspaceFeaturesDto,
} from './workspaces.dto.js';
import { WorkspacesService } from './workspaces.service.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * Access-control management. Listing your workspaces / creating one needs
 * authentication only; the members surface is workspace-scoped RBAC:
 * viewers can see the roster, only workspace admins can change it (403).
 */
@ApiTags('workspaces')
@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly features: FeaturesService,
  ) {}

  @Get()
  @Returns('ListWorkspacesResponse')
  @ApiOperation({ summary: "Caller's workspaces (platform admins see all)" })
  list(@CurrentPrincipal() principal: Principal): Promise<ListWorkspacesResponse> {
    return this.workspaces.list(principal);
  }

  @Post()
  @Returns('CreateWorkspaceResponse')
  @ApiOperation({ summary: 'Create a workspace — the creator becomes its admin + trusted operator' })
  create(@CurrentPrincipal() principal: Principal, @Body() dto: CreateWorkspaceDto): Promise<CreateWorkspaceResponse> {
    return this.workspaces.create(principal, dto.name);
  }

  @Get(':id/deletion-preview')
  @Returns('WorkspaceDeletionPreviewResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'What deleting the workspace would destroy, counted (workspace admin)' })
  deletionPreview(@Param('id', ParseUUIDPipe) id: string): Promise<WorkspaceDeletionPreviewResponse> {
    return this.workspaces.deletionPreview(id);
  }

  // Feature toggles (#604). Every member and guest reads them — the app hides
  // what is off — and only a workspace admin changes them.
  @Get(':id/features')
  @Returns('WorkspaceFeaturesResponse')
  @Access('viewer', 'workspace', { guests: true })
  @ApiOperation({ summary: 'The sections switched off in this workspace' })
  async getFeatures(@Param('id', ParseUUIDPipe) id: string): Promise<WorkspaceFeaturesResponse> {
    return { workspaceId: id, disabled: await this.features.disabled(id), unavailable: this.features.unavailable() };
  }

  @Put(':id/features')
  @Returns('WorkspaceFeaturesResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Switch sections off or back on (workspace admin): hides them in the app, 404s their routes and MCP tools' })
  async setFeatures(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkspaceFeaturesDto,
  ): Promise<WorkspaceFeaturesResponse> {
    return { workspaceId: id, disabled: await this.features.set(id, dto.disabled, principal.userId), unavailable: this.features.unavailable() };
  }

  @Patch(':id')
  @Returns('UpdateWorkspaceResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Rename the workspace (workspace admin)' })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkspaceDto,
  ): Promise<UpdateWorkspaceResponse> {
    return this.workspaces.rename(principal, id, dto.name);
  }

  @Delete(':id')
  @Returns('DeleteWorkspaceResponse')
  @Access('admin', 'workspace')
  @ApiOperation({
    summary: 'Delete the workspace and everything in it (workspace admin). Gone at once; contents removed in the background',
  })
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteWorkspaceQueryDto,
  ): Promise<DeleteWorkspaceResponse> {
    return this.workspaces.remove(principal, id, query.confirm);
  }

  @Get(':id/members')
  @Returns('ListWorkspaceMembersResponse')
  @Access('viewer', 'workspace')
  @ApiOperation({ summary: 'Workspace member roster (any member)' })
  listMembers(@Param('id', ParseUUIDPipe) id: string): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.listMembers(id);
  }

  @Get(':id/candidates')
  @Returns('ListWorkspaceCandidatesResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Users who are not members yet, for the add-member picker (workspace admin)' })
  listCandidates(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListCandidatesQueryDto,
  ): Promise<ListWorkspaceCandidatesResponse> {
    return this.workspaces.listCandidates(id, query.q, query.limit ?? 20);
  }

  @Post(':id/members')
  @Returns('ListWorkspaceMembersResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Add (or re-role) a member by email (workspace admin)' })
  addMember(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMemberDto,
  ): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.addMember(id, dto, principal.userId);
  }

  @Patch(':id/members/:userId')
  @Returns('ListWorkspaceMembersResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Change a member role / trusted-operator flag / capabilities (workspace admin)' })
  updateMember(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.updateMember(id, userId, dto, principal.userId);
  }

  @Delete(':id/members/:userId')
  @Returns('ListWorkspaceMembersResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Remove a member (workspace admin; last admin is protected)' })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.removeMember(id, userId);
  }
}
