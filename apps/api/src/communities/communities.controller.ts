import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { ListCommunitiesResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { vmsg } from '../common/validation.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ListReleaseTagsQueryDto } from '../temporal/temporal.dto.js';
import { CommunitiesService } from './communities.service.js';

export class ListCommunitiesQueryDto extends ListReleaseTagsQueryDto {
  @ApiPropertyOptional({ maxLength: 2000, description: 'A broad question; communities closest to it first. Largest first when absent' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: vmsg('maxLength') })
  q?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, description: '10 when absent' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(50, { message: vmsg('max') })
  limit?: number;
}

/** Communities of pages for global questions (#81, phase 7). Only those the caller may read whole. */
@ApiTags('graph')
@Controller('v1/graph')
export class CommunitiesController {
  constructor(
    private readonly communities: CommunitiesService,
    private readonly permissions: PermissionService,
  ) {}

  @Get('communities')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Communities of related pages with their summaries, closest to a question first' })
  async list(@Query() query: ListCommunitiesQueryDto, @CurrentPrincipal() principal: Principal): Promise<ListCommunitiesResponse> {
    const scope = await this.permissions.scopeFor(principal, query.workspaceId);
    return { communities: await this.communities.overview(scope, query.q, query.limit ?? 10) };
  }
}
