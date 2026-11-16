import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ContextResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { noTrackOf } from '../analytics/analytics.recorder.js';
import { Returns } from '../common/returns.decorator.js';
import { ContextService } from './context.service.js';
import { ContextDto } from './context.dto.js';

@ApiTags('search')
@Controller('v1/context')
export class ContextController {
  constructor(
    private readonly context: ContextService,
    private readonly permissions: PermissionService,
  ) {}

  @Post()
  @Returns('ContextResponse')
  @HttpCode(200)
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'What the workspace already knows about a ticket: pages, glossary terms and project memory as pointers, within a token budget' })
  async run(@Body() dto: ContextDto, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<ContextResponse> {
    return this.context.context(dto, await this.permissions.scopeFor(principal, dto.workspaceId), { principal, noTrack: noTrackOf(req.headers) });
  }
}
