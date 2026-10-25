import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccessRequestEntry, ListAccessRequestsResponse } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AccessRequestsService } from './access-requests.service.js';
import {
  ApproveAccessRequestDto,
  CreateAccessRequestDto,
  DenyAccessRequestDto,
  ListAccessRequestsQueryDto,
} from './permissions.dto.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * Access requests (#76, phase 5). Asking and listing are open to guests, who
 * ask only about what they can already open and list only their own; deciding
 * needs `manage` on the node, which only the service can work out.
 */
@ApiTags('access')
@Controller('v1/access-requests')
export class AccessRequestsController {
  constructor(private readonly requests: AccessRequestsService) {}

  @Post()
  @Returns('AccessRequestEntry')
  @Access('viewer', 'body', { guests: true })
  @ApiOperation({ summary: 'Ask for a level on a page or project (409 when already granted, or already asked)' })
  create(@Body() dto: CreateAccessRequestDto, @CurrentPrincipal() principal: Principal): Promise<AccessRequestEntry> {
    return this.requests.create(principal, dto);
  }

  @Get()
  @Returns('ListAccessRequestsResponse')
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: "The caller's own requests (mine=1), or the ones they may decide" })
  list(@Query() query: ListAccessRequestsQueryDto, @CurrentPrincipal() principal: Principal): Promise<ListAccessRequestsResponse> {
    return this.requests.list(principal, query.workspaceId, {
      status: query.status,
      mine: query.mine === '1' || query.mine === 'true',
      resourceType: query.resourceType,
      resourceId: query.resourceId,
    });
  }

  @Post(':id/approve')
  @Returns('AccessRequestEntry')
  @Access('viewer', 'access-request')
  @ApiOperation({ summary: 'Approve with a level: grants it on every restricted node that kept the requester out (needs manage on each)' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveAccessRequestDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AccessRequestEntry> {
    return this.requests.approve(principal, id, dto.level);
  }

  @Post(':id/deny')
  @Returns('AccessRequestEntry')
  @Access('viewer', 'access-request')
  @ApiOperation({ summary: 'Deny, optionally saying why (needs manage)' })
  deny(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DenyAccessRequestDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AccessRequestEntry> {
    return this.requests.deny(principal, id, dto.reason);
  }

  @Post(':id/cancel')
  @Returns('AccessRequestEntry')
  @Access('viewer', 'access-request', { guests: true })
  @ApiOperation({ summary: 'Withdraw your own pending request' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<AccessRequestEntry> {
    return this.requests.cancel(principal, id);
  }
}
