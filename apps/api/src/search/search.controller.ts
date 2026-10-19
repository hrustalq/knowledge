import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { noTrackOf } from '../analytics/analytics.recorder.js';
import { SearchService } from './search.service.js';
import { SearchDto } from './search.dto.js';

@ApiTags('search')
@Controller('v1/search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly permissions: PermissionService,
  ) {}

  @Post()
  @HttpCode(200)
  // Guests too: results are filtered to the pages they were granted (#76).
  @Access('viewer', 'body', { guests: true })
  @ApiOperation({ summary: 'Search indexed chunks: semantic, keyword (BM25) or hybrid (RRF fusion + graph expansion)' })
  async run(@Body() dto: SearchDto, @CurrentPrincipal() principal: Principal, @Req() req: Request) {
    return this.search.search(dto, await this.permissions.scopeFor(principal, dto.workspaceId), {
      principal,
      noTrack: noTrackOf(req.headers),
    });
  }
}
