import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
  CreateSourcePageResponse,
  DocumentSourceInfo,
  DocumentSourceWebhookResponse,
  SourceRecipePreview,
  SourceSettingsResponse,
  SourceTreeRecipeState,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PermissionService } from '../permissions/permission.service.js';
import { Returns } from '../common/returns.decorator.js';
import {
  CreateSourcePageDto,
  DraftSourceTreeRecipeDto,
  PreviewSourceRecipeDto,
  PreviewSourceTreeRecipeDto,
  RestoreDocumentSourceDto,
  SaveSourceRecipeDto,
  SaveSourceTreeRecipeDto,
  SourceSettingsQueryDto,
  UpdateDocumentSourceDto,
  UpdateSourceSettingsDto,
} from './web-sources.dto.js';
import { SourceSettingsService } from './source-settings.service.js';
import { WebSourcesService } from './web-sources.service.js';

/**
 * Source-backed pages (#674): link a page to a URL, and the page's source
 * panel. Every route is `sources`-toggled and 404s while WEB_SOURCES_ENABLED
 * is off. Reading the source is `viewer`; everything that changes what the
 * page shows is `editor`, as editing it would be.
 */
@ApiTags('sources')
@Controller('v1')
@Feature('sources')
export class WebSourcesController {
  constructor(
    private readonly sources: WebSourcesService,
    private readonly permissions: PermissionService,
    private readonly settings: SourceSettingsService,
  ) {}

  @Get('sources/settings')
  @Returns('SourceSettingsResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: "The workspace's crawl limits: what it asks for, the deployment's ceiling, and what applies" })
  getSettings(@Query() q: SourceSettingsQueryDto): Promise<SourceSettingsResponse> {
    return this.settings.get(q.workspaceId);
  }

  @Put('sources/settings')
  @Returns('SourceSettingsResponse')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Set the crawl limits; null inherits the WEB_SOURCE_CRAWL_* env, which a value may only lower' })
  setSettings(@Body() dto: UpdateSourceSettingsDto, @CurrentPrincipal() principal: Principal): Promise<SourceSettingsResponse> {
    const { workspaceId, ...requested } = dto;
    return this.settings.set(workspaceId, requested, principal?.userId);
  }

  @Post('sources')
  @Returns('CreateSourcePageResponse')
  @Access('editor', 'body')
  @ApiOperation({
    summary:
      'Create a source-backed page from a URL (markdown or HTML). The first version is read now; the page is ' +
      'read-only and follows the source on its interval, webhook or Sync now',
  })
  @ApiResponse({ status: 400, description: 'The URL could not be read; `details.needsCredential` when the host refused without one' })
  async link(@Body() dto: CreateSourcePageDto, @CurrentPrincipal() principal: Principal): Promise<CreateSourcePageResponse> {
    // Placing a page under a restricted node is editing that node (#76), as for any new page.
    await this.permissions.requireCreateUnder(await this.permissions.scopeFor(principal, dto.workspaceId), {
      projectId: dto.projectId,
      ...(dto.parentId ? { parentId: dto.parentId } : {}),
    });
    return this.sources.link(dto, principal.userId);
  }

  @Get('documents/:id/source')
  @Returns('DocumentSourceInfo')
  @Access('viewer', 'document')
  @ApiOperation({ summary: "The page's source: where it reads from, when it last checked, paused, failing or behind" })
  info(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentSourceInfo> {
    return this.sources.info(id);
  }

  @Patch('documents/:id/source')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'How often the source is checked, and what a new version does to pages linking it' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentSourceDto): Promise<DocumentSourceInfo> {
    return this.sources.update(id, dto);
  }

  @Post('documents/:id/source/pause')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Stop writing new versions; they are counted until the source is resumed' })
  pause(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentSourceInfo> {
    return this.sources.pause(id);
  }

  @Post('documents/:id/source/resume')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Follow the source again: a sync is queued and writes whatever it says now' })
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<DocumentSourceInfo> {
    return this.sources.resume(id, principal.userId);
  }

  @Post('documents/:id/source/restore')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Restore an earlier revision of the page. Pauses the source and alerts its owner' })
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestoreDocumentSourceDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentSourceInfo> {
    return this.sources.restore(id, dto.revisionId, principal.userId);
  }

  // ---- extraction recipes (#674, phase 2): editor, as editing the page would be.

  @Post('documents/:id/source/recipe/preview')
  @Returns('SourceRecipePreview')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'What a recipe makes of the last fetched version, beside the page as it reads now, with its check results' })
  previewRecipe(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PreviewSourceRecipeDto): Promise<SourceRecipePreview> {
    return this.sources.previewRecipe(id, dto.recipe);
  }

  @Put('documents/:id/source/recipe')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: "Save the page's extraction recipe, approving a drafted one or not. The current version is re-read through it" })
  @ApiResponse({ status: 409, description: 'The recipe fails its checks on the current version (`details.failures`), or the proposal is stale' })
  saveRecipe(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveSourceRecipeDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentSourceInfo> {
    return this.sources.saveRecipe(id, dto.recipe, dto.proposalId, principal.userId);
  }

  @Post('documents/:id/source/recipe/draft')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Ask the interpreter agent to draft a recipe for the last fetched version; it waits for review' })
  draftRecipe(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<DocumentSourceInfo> {
    return this.sources.draftRecipe(id, principal.userId, principal.locale);
  }

  @Post('documents/:id/source/recipe/dismiss')
  @Returns('DocumentSourceInfo')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Keep the current recipe: reject the drafted one and clear the layout-changed note. A held version stays held' })
  dismissRecipe(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<DocumentSourceInfo> {
    return this.sources.dismissRecipe(id, principal.userId);
  }

  // ---- tree recipes (#674, phase 3b): the connector's recipe, editor like Sync now.
  // The page a preview, save or draft reads is one the caller may view: its text is in the answer.

  @Get('connectors/:id/source/recipe')
  @Returns('SourceTreeRecipeState')
  @Access('viewer', 'connector')
  @ApiOperation({ summary: "The connector's tree recipe, a drafted one waiting for review, and the crawled pages a preview can read" })
  async treeRecipe(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<SourceTreeRecipeState> {
    return this.sources.treeRecipe(id, await this.treeScope(id, principal));
  }

  @Post('connectors/:id/source/recipe/preview')
  @Returns('SourceRecipePreview')
  @Access('editor', 'connector')
  @ApiOperation({ summary: "What a tree recipe makes of one crawled page's last fetched version (default: the root), with its check results" })
  async previewTreeRecipe(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewSourceTreeRecipeDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SourceRecipePreview> {
    return this.sources.previewTreeRecipe((await this.treePage(id, dto.documentId, principal)).page, dto.recipe);
  }

  @Put('connectors/:id/source/recipe')
  @Returns('SourceTreeRecipeState')
  @Access('editor', 'connector')
  @ApiOperation({
    summary:
      "Save the connector's tree recipe, approving a drafted one or not. Checked on one page (default: the root); " +
      'a pull is queued that re-reads every page without its own recipe',
  })
  @ApiResponse({ status: 409, description: 'The recipe fails its checks on that page (`details.failures`), or the proposal is stale' })
  async saveTreeRecipe(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveSourceTreeRecipeDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SourceTreeRecipeState> {
    const { page, scope } = await this.treePage(id, dto.documentId, principal);
    return this.sources.saveTreeRecipe(page, dto.recipe, dto.proposalId, principal.userId, scope);
  }

  @Post('connectors/:id/source/recipe/draft')
  @Returns('SourceTreeRecipeState')
  @Access('editor', 'connector')
  @ApiOperation({ summary: "Ask the interpreter agent to draft a tree recipe from one crawled page's last version (default: the root)" })
  async draftTreeRecipe(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DraftSourceTreeRecipeDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SourceTreeRecipeState> {
    const { page, scope } = await this.treePage(id, dto.documentId, principal);
    return this.sources.draftTreeRecipe(page, principal.userId, principal.locale, scope);
  }

  @Post('connectors/:id/source/recipe/dismiss')
  @Returns('SourceTreeRecipeState')
  @Access('editor', 'connector')
  @ApiOperation({ summary: 'Keep the current tree recipe: reject the drafted one' })
  async dismissTreeRecipe(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<SourceTreeRecipeState> {
    return this.sources.dismissTreeRecipe(id, principal.userId, await this.treeScope(id, principal));
  }

  private async treeScope(connectorId: string, principal: Principal) {
    return this.permissions.scopeFor(principal, await this.sources.workspaceOf(connectorId));
  }

  /** The page an operation reads, refused like any page the caller may not open, and the caller's scope. */
  private async treePage(connectorId: string, documentId: string | undefined, principal: Principal) {
    const page = await this.sources.treePage(connectorId, documentId);
    const scope = await this.permissions.scopeFor(principal, page.row.workspaceId);
    await this.permissions.requireLevel(scope, { type: 'document', id: page.link.documentId }, 'view');
    return { page, scope };
  }

  @Post('documents/:id/source/webhook')
  @Returns('DocumentSourceWebhookResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: "A new webhook signing secret for the page's source, shown once; the old one stops working" })
  webhook(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentSourceWebhookResponse> {
    return this.sources.rotateWebhook(id);
  }
}
