import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ListSessionsResponse, ListUsersResponse, RevokeSessionsResponse, UserSummary } from '@knowledge/contracts';
import { CurrentPrincipal, PlatformAdmin } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CreateUserDto, UpdateUserDto } from './users.dto.js';
import { UsersService } from './users.service.js';
import { requestMeta } from '../common/client-ip.js';

/** Users management — the whole controller is platform-admin only (403 otherwise). */
@ApiTags('users')
@PlatformAdmin()
@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List all users with their workspace memberships (platform admin)' })
  list(): Promise<ListUsersResponse> {
    return this.users.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a user (platform admin); without a password, the user is mailed an invite to set one' })
  create(@CurrentPrincipal() principal: Principal, @Body() dto: CreateUserDto): Promise<UserSummary> {
    return this.users.create(principal, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user: rename, (de)admin, disable/enable, password override' })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserSummary> {
    return this.users.update(principal, id, dto);
  }

  @Get(':id/sessions')
  @ApiOperation({ summary: "A user's live login sessions (platform admin, #75)" })
  listSessions(@Param('id', ParseUUIDPipe) id: string): Promise<ListSessionsResponse> {
    return this.users.listSessions(id);
  }

  /** Sign a person out everywhere without disabling them — a lost laptop, say. */
  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @ApiOperation({ summary: "Revoke every live session of a user (platform admin); API keys are untouched" })
  revokeSessions(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<RevokeSessionsResponse> {
    return this.users.revokeSessions(principal, id, requestMeta(req).ip);
  }
}
