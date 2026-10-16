import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CodeUsagesResponse, ComponentDeclarationView } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ComponentUsagesService } from './component-usages.service.js';
import { ComponentsService } from './components.service.js';
import { CodeUsagesQueryDto, ComponentUsagesQueryDto } from './components.dto.js';

/**
 * A page's component declaration (#236). Mounted on `v1/documents` beside
 * `DocumentsController`; the routes are `:id/<literal>`, so there is no ordering
 * hazard with its `@Get(':id')`.
 */
@ApiTags('documents')
@Controller('v1/documents')
export class ComponentsController {
  constructor(
    private readonly components: ComponentsService,
    private readonly usages: ComponentUsagesService,
    private readonly permissions: PermissionService,
  ) {}

  @Get(':id/component')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'The code the page declares it documents (its `component:` frontmatter), as resolved to a codebase ' +
      'connector at its default-branch head; null when it declares none. `warning` says why a declaration ' +
      'resolved to no connector',
  })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ComponentDeclarationView | null> {
    return this.components.view(id);
  }

  @Get(':id/component/usages')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'Where the code this page declares is used, at the connector\'s indexed head: each importing file, what it ' +
      'imports, and the pages documenting it. Pages the caller may not open are counted, never titled. 404 when ' +
      'the page declares no component',
  })
  async usagesOf(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ComponentUsagesQueryDto,
  ): Promise<CodeUsagesResponse> {
    const scope = await this.permissions.scopeForDocument(principal, id);
    return this.usages.forDocument(scope, id, { symbols: query.symbols, limit: query.limit });
  }
}

/** The same answer for a path rather than a page (#236), the REST twin of `knowledge_code_usages({ path })`. */
@ApiTags('connectors')
@Controller('v1/code-usages')
export class CodeUsagesController {
  constructor(
    private readonly usages: ComponentUsagesService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({
    summary:
      'Where a file, directory or glob is used in one of the workspace\'s code connectors, the pages documenting ' +
      'each usage site, and the component pages covering the path. Pages the caller may not open are counted, ' +
      'never titled',
  })
  async list(@CurrentPrincipal() principal: Principal, @Query() query: CodeUsagesQueryDto): Promise<CodeUsagesResponse> {
    const scope = await this.permissions.scopeFor(principal, query.workspaceId);
    return this.usages.forPath(scope, query);
  }
}
