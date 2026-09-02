import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateWorkspaceResponse,
  ListWorkspaceMembersResponse,
  ListWorkspacesResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AddMemberDto, CreateWorkspaceDto, UpdateMemberDto } from './workspaces.dto.js';
import { WorkspacesService } from './workspaces.service.js';

/**
 * Access-control management. Listing your workspaces / creating one needs
 * authentication only; the members surface is workspace-scoped RBAC:
 * viewers can see the roster, only workspace admins can change it (403).
 */
@ApiTags('workspaces')
@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOperation({ summary: "Caller's workspaces (platform admins see all)" })
  list(@CurrentPrincipal() principal: Principal): Promise<ListWorkspacesResponse> {
    return this.workspaces.list(principal);
  }

  @Post()
  @ApiOperation({ summary: 'Create a workspace — the creator becomes its admin + trusted operator' })
  create(@CurrentPrincipal() principal: Principal, @Body() dto: CreateWorkspaceDto): Promise<CreateWorkspaceResponse> {
    return this.workspaces.create(principal, dto.name);
  }

  @Get(':id/members')
  @Access('viewer', 'workspace')
  @ApiOperation({ summary: 'Workspace member roster (any member)' })
  listMembers(@Param('id', ParseUUIDPipe) id: string): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.listMembers(id);
  }

  @Post(':id/members')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Add (or re-role) a member by email (workspace admin)' })
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMemberDto): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.addMember(id, dto);
  }

  @Patch(':id/members/:userId')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Change a member role / trusted-operator flag (workspace admin)' })
  updateMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.updateMember(id, userId, dto);
  }

  @Delete(':id/members/:userId')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Remove a member (workspace admin; last admin is protected)' })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<ListWorkspaceMembersResponse> {
    return this.workspaces.removeMember(id, userId);
  }
}
