import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ListUsersResponse, UserSummary } from '@knowledge/contracts';
import { CurrentPrincipal, PlatformAdmin } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CreateUserDto, UpdateUserDto } from './users.dto.js';
import { UsersService } from './users.service.js';

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
}
