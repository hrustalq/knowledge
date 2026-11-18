import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';
import { HOME_WIDGETS, type HomeLayoutResponse, type HomeResponse, type HomeWidget } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { PermissionService } from '../permissions/permission.service.js';
import { HomeService } from './home.service.js';

/** PUT /v1/workspaces/:id/home/layout (#1243): the whole layout, replacing the last; null is the built-in one. */
export class UpdateHomeLayoutDto {
  @ApiPropertyOptional({
    enum: HOME_WIDGETS,
    isArray: true,
    nullable: true,
    type: String,
    description: 'The widgets to show, in order; one left out is hidden. Null (or omitted) goes back to the built-in layout.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(HOME_WIDGETS.length)
  @IsIn(HOME_WIDGETS, { each: true })
  widgets?: HomeWidget[] | null;
}

@ApiTags('workspaces')
@Controller('v1/workspaces')
export class HomeController {
  constructor(
    private readonly home: HomeService,
    private readonly permissions: PermissionService,
  ) {}

  // Guests too: every widget is read under their scope, and the ones whose
  // routes refuse guests are left out of their answer.
  @Get(':id/home')
  @Returns('HomeResponse')
  @Access('viewer', 'workspace', { guests: true })
  @ApiOperation({ summary: "The workspace home: the layout and the data of every widget the caller may read" })
  async get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<HomeResponse> {
    return this.home.get(await this.permissions.scopeFor(principal, id), principal);
  }

  @Put(':id/home/layout')
  @Returns('HomeLayoutResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Set which home widgets show and in what order (workspace admin)' })
  setLayout(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHomeLayoutDto,
  ): Promise<HomeLayoutResponse> {
    return this.home.setLayout(id, dto.widgets ?? null, principal.userId);
  }
}
