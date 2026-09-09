import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { UserProfileResponse } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ProfilesService } from './profiles.service.js';

/**
 * A member's profile within one workspace.
 *
 * `@Access('viewer', 'query')` on purpose: the roster behind this
 * (GET /v1/workspaces/:id/members) is already viewer-readable, so anyone who
 * can see a colleague's name in a merge request can open the page behind it.
 * The workspace comes from the query string, so no new WorkspaceSource is
 * needed — the guard resolves it in PG before this handler runs.
 */
@ApiTags('profiles')
@Controller('v1/profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':userId')
  @Access('viewer', 'query')
  @ApiOperation({ summary: "A workspace member's identity, membership, open work and pages" })
  @ApiQuery({ name: 'workspaceId', required: true })
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<UserProfileResponse> {
    return this.profiles.get(principal, workspaceId, userId);
  }
}
