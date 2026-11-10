import { Body, Controller, Delete, Get, HttpCode, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CredentialResponse, CredentialsResponse } from '@knowledge/contracts';
import { CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ConnectionsService } from './connections.service.js';
import { UpdateCredentialDto } from './connections.dto.js';
import { CredentialsService } from './credentials.service.js';

/**
 * The caller's connected accounts (#857). `me` routes act on
 * `principal.userId`: an id that is someone else's answers 403, and no
 * route returns a secret — hints only.
 */
@ApiTags('credentials')
@Controller('v1/me/credentials')
export class CredentialsController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly connections: ConnectionsService,
  ) {}

  @Get()
  @Returns('CredentialsResponse')
  @ApiOperation({ summary: 'My connected accounts, and the workspaces using each' })
  async list(@CurrentPrincipal() principal: Principal): Promise<CredentialsResponse> {
    return { credentials: await this.credentials.list(principal.userId) };
  }

  @Patch(':id')
  @Returns('CredentialResponse')
  @ApiOperation({ summary: 'Rotate one of my credentials (same account only), in every workspace using it' })
  async rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCredentialDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CredentialResponse> {
    return { credential: await this.connections.rotateCredential(id, dto.credential, principal.userId) };
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disconnect one of my credentials (409 while a workspace uses it)' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.credentials.remove(id, principal.userId);
  }
}
