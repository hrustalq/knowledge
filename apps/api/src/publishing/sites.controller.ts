import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ProjectSiteResponse, PublishedSiteSummary, SiteVersionSummary } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { CreateSiteDto, CreateSiteVersionDto, UpdateSiteDto, UpdateSiteVersionDto } from './sites.dto.js';
import { SitesService } from './sites.service.js';

/**
 * Managing a project's published site (docs/features/44). Seeing whether a
 * project has one is open to anyone who can read the project; everything that
 * changes what the public sees is an admin's, like the workspace switch that
 * allows it. The anonymous reader is `PublicSitesController` under /v1/public.
 */
@ApiTags('publishing')
@Controller('v1')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get('projects/:id/site')
  @Access('viewer', 'project')
  @ApiOperation({ summary: 'The project’s published site, if any, and what the workspace allows' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ProjectSiteResponse> {
    return this.sites.forProject(id);
  }

  @Post('projects/:id/site')
  @Access('admin', 'project')
  @ApiOperation({ summary: 'Create the project’s site (a draft) with a live “Latest” version, and build it' })
  @ApiResponse({ status: 403, description: 'Sites are off for the workspace or the deployment (details.reason site.disabledByWorkspace)' })
  @ApiResponse({ status: 409, description: 'The project already has a site, or the slug is taken' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSiteDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PublishedSiteSummary> {
    return this.sites.create(id, dto, principal?.userId);
  }

  @Patch('sites/:id')
  @Access('admin', 'site')
  @ApiOperation({ summary: 'Change the address, root page, theme, indexing or default version' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSiteDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PublishedSiteSummary> {
    return this.sites.update(id, dto, principal?.userId);
  }

  @Delete('sites/:id')
  @Access('admin', 'site')
  @ApiOperation({ summary: 'Delete the site and its versions. Pages are untouched; the address is freed' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<{ deleted: true }> {
    return this.sites.remove(id, principal?.userId);
  }

  @Post('sites/:id/publish')
  @Access('admin', 'site')
  @ApiOperation({ summary: 'Put the site live: anyone with the address can read it' })
  @ApiResponse({ status: 403, description: 'Sites are off for the workspace or the deployment' })
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<PublishedSiteSummary> {
    return this.sites.publish(id, principal?.userId);
  }

  @Post('sites/:id/unpublish')
  @Access('admin', 'site')
  @ApiOperation({ summary: 'Take the site down. It stops resolving at once; its configuration is kept' })
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<PublishedSiteSummary> {
    return this.sites.unpublish(id, principal?.userId);
  }

  @Post('sites/:id/versions')
  @Access('admin', 'site')
  @ApiOperation({ summary: 'Add a version: `live` follows a branch, `frozen` is a snapshot taken now' })
  @ApiResponse({ status: 409, description: 'Slug taken or shadowing a top-level page, or the version limit is reached' })
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSiteVersionDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SiteVersionSummary> {
    return this.sites.createVersion(id, dto, principal?.userId);
  }

  @Patch('site-versions/:id')
  @Access('admin', 'site-version')
  @ApiOperation({ summary: 'Rename a version, freeze or unfreeze it, or point it at another branch (rebuilds)' })
  updateVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSiteVersionDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SiteVersionSummary> {
    return this.sites.updateVersion(id, dto, principal?.userId);
  }

  @Post('site-versions/:id/rebuild')
  @Access('admin', 'site-version')
  @ApiOperation({ summary: 'Re-snapshot the version now. Readers keep the old snapshot until the new one is complete' })
  rebuild(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<SiteVersionSummary> {
    return this.sites.rebuild(id, principal?.userId);
  }

  @Delete('site-versions/:id')
  @Access('admin', 'site-version')
  @ApiOperation({ summary: 'Delete a version and its snapshot. The default version cannot be deleted' })
  deleteVersion(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<{ deleted: true }> {
    return this.sites.deleteVersion(id, principal?.userId);
  }
}
