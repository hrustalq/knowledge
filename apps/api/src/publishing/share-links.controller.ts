import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  CreateShareLinkResponse,
  PublishingSettingsResponse,
  ShareLinkListResponse,
  ShareLinkSummary,
  WorkspaceShareLinksResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PublishingSettingsService } from './publishing-settings.service.js';
import { CreateShareLinkDto, UpdatePublishingSettingsDto, UpdateShareLinkDto } from './share-links.dto.js';
import { ShareLinksService } from './share-links.service.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * Managing share links and the workspace's publishing switches
 * (docs/features/43). Authenticated routes only; the anonymous reader is
 * `PublicSharesController` under /v1/public.
 *
 * Creating a link is an editor's act — it hands the page to people outside the
 * workspace — while listing a page's links is open to anyone who can read it.
 * The switches and the inventory of every link are an admin's.
 */
@ApiTags('publishing')
@Controller('v1')
export class ShareLinksController {
  constructor(
    private readonly shares: ShareLinksService,
    private readonly settings: PublishingSettingsService,
  ) {}

  @Get('documents/:id/shares')
  @Returns('ShareLinkListResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'A page’s live share links, and what the workspace allows' })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<ShareLinkListResponse> {
    return this.shares.list(id);
  }

  @Post('documents/:id/shares')
  @Returns('CreateShareLinkResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Create a public, read-only link to the page (and optionally its subpages)' })
  @ApiResponse({ status: 403, description: 'Sharing is off for the workspace or the deployment (details.reason share.disabledByWorkspace)' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShareLinkDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateShareLinkResponse> {
    return this.shares.create(id, dto, principal?.userId);
  }

  @Patch('shares/:id')
  @Returns('ShareLinkSummary')
  @Access('editor', 'share-link')
  @ApiOperation({ summary: 'Change a link’s expiry, password or subtree' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShareLinkDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShareLinkSummary> {
    return this.shares.update(id, dto, principal?.userId);
  }

  @Delete('shares/:id')
  @Access('editor', 'share-link')
  @ApiOperation({ summary: 'Revoke a link. It stops working at once; the row stays in the inventory' })
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<{ revoked: true }> {
    return this.shares.revoke(id, principal?.userId);
  }

  @Get('workspaces/:id/shares')
  @Returns('WorkspaceShareLinksResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Every share link in the workspace, revoked and expired included' })
  inventory(@Param('id', ParseUUIDPipe) id: string): Promise<WorkspaceShareLinksResponse> {
    return this.shares.listWorkspace(id);
  }

  @Get('workspaces/:id/publishing-settings')
  @Returns('PublishingSettingsResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'The publishing switches: what applies, the workspace override, and the deployment ceiling' })
  getSettings(@Param('id', ParseUUIDPipe) id: string): Promise<PublishingSettingsResponse> {
    return this.settings.get(id);
  }

  @Patch('workspaces/:id/publishing-settings')
  @Returns('PublishingSettingsResponse')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Override the publishing switches; null on a key goes back to the default (off)' })
  updateSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePublishingSettingsDto,
  ): Promise<PublishingSettingsResponse> {
    return this.settings.update(id, dto);
  }
}
