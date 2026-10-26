import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ListUserGroupMembersResponse, ListUserGroupsResponse, UserGroupSummary } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AccessService } from '../auth/access.service.js';
import { GroupsService } from './groups.service.js';
import { AclEventsService } from './acl-events.service.js';
import {
  CreateUserGroupDto,
  ListUserGroupsQueryDto,
  UpdateUserGroupDto,
  UpdateUserGroupMembersDto,
} from './permissions.dto.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * User groups (#76). Reading is `viewer`, the same bar as the member roster a
 * group is drawn from — a guest reads neither. Every change is workspace
 * `admin`, because a group is what restrictions grant to: adding someone to
 * one is granting them whatever it holds.
 */
@ApiTags('groups')
@Controller('v1/groups')
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly access: AccessService,
    private readonly aclEvents: AclEventsService,
  ) {}

  @Get()
  @Returns('ListUserGroupsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: "The workspace's user groups, with member counts" })
  list(@Query() query: ListUserGroupsQueryDto): Promise<ListUserGroupsResponse> {
    return this.groups.list(query.workspaceId);
  }

  @Post()
  @Returns('UserGroupSummary')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Create a manual group (workspace admin; 409 when the name is taken)' })
  create(@Body() dto: CreateUserGroupDto): Promise<UserGroupSummary> {
    return this.groups.create(dto);
  }

  @Patch(':id')
  @Returns('UserGroupSummary')
  @Access('admin', 'group')
  @ApiOperation({ summary: 'Rename a group or change its description (409 for a connector or SCIM group)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserGroupDto): Promise<UserGroupSummary> {
    return this.groups.update(id, dto);
  }

  @Delete(':id')
  @Access('admin', 'group')
  @ApiOperation({ summary: 'Delete a group and its memberships (409 for a connector or SCIM group)' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ deleted: true }> {
    const workspaceId = await this.access.workspaceOfGroup(id);
    const result = await this.groups.remove(id);
    // Its grants went with it: whoever held them through it may see less now.
    await this.aclEvents.changed(workspaceId, principal?.userId);
    return result;
  }

  @Get(':id/members')
  @Returns('ListUserGroupMembersResponse')
  @Access('viewer', 'group')
  @ApiOperation({ summary: "A group's members with their workspace roles" })
  listMembers(@Param('id', ParseUUIDPipe) id: string): Promise<ListUserGroupMembersResponse> {
    return this.groups.listMembers(id);
  }

  @Put(':id/members')
  @Returns('ListUserGroupMembersResponse')
  @Access('admin', 'group')
  @ApiOperation({
    summary: 'Add and remove members in one transaction (workspace admin; 400 for a non-member, 409 for a connector or SCIM group)',
  })
  async updateMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserGroupMembersDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ListUserGroupMembersResponse> {
    const result = await this.groups.updateMembers(id, dto);
    await this.aclEvents.changed(await this.access.workspaceOfGroup(id), principal?.userId);
    return result;
  }
}
