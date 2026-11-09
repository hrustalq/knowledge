import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type {
  GlossaryTerm,
  ListGlossaryResponse,
  SuggestGlossaryTermsResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { GlossaryService } from './glossary.service.js';
import {
  CreateGlossaryTermDto,
  ListGlossaryQueryDto,
  SuggestGlossaryTermsDto,
  UpdateGlossaryTermDto,
} from './glossary.dto.js';
import { Returns } from '../common/returns.decorator.js';
import { AccessService } from '../auth/access.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import type { AccessScope } from '../permissions/access-scope.js';

/**
 * Glossary (docs/features/14). Reading is `viewer` because every reader needs
 * the roster — the term linker runs on every rendered page — and writing is
 * `editor`, the same bar as editing the documents the vocabulary describes.
 * A defining page's title is page data, so every route reads it under the
 * caller's scope (#712).
 */
@ApiTags('glossary')
@Controller('v1/glossary')
export class GlossaryController {
  constructor(
    private readonly glossary: GlossaryService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
  ) {}

  private async termScope(principal: Principal, termId: string): Promise<AccessScope> {
    return this.permissions.scopeFor(principal, await this.access.workspaceOf('glossary-term', termId));
  }

  @Get()
  @Returns('ListGlossaryResponse')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict to one project' })
  @ApiOperation({
    summary:
      'The glossary — the roster the read-side term linker matches against. ' +
      'Scoped to one project with projectId; without it, the whole workspace.',
  })
  async list(
    @Query() query: ListGlossaryQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ListGlossaryResponse> {
    return this.glossary.list(query, await this.permissions.scopeFor(principal, query.workspaceId));
  }

  @Post()
  @Returns('GlossaryTerm')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Add a term to a project (409 when that project already defines it)' })
  async create(
    @Body() dto: CreateGlossaryTermDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GlossaryTerm> {
    return this.glossary.create(dto, await this.permissions.scopeFor(principal, dto.workspaceId), principal?.userId);
  }

  /**
   * Declared before `:id` — Nest matches in declaration order, so a literal
   * segment sharing the prefix has to come first (same reason
   * `GET /v1/documents/tree` precedes `GET /v1/documents/:id`).
   */
  @Post('suggest')
  @Returns('SuggestGlossaryTermsResponse')
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      'LLM term extraction over a page or a draft — proposals only, nothing is saved; ' +
      'enabled=false when the assistant provider is none',
  })
  async suggest(
    @Body() dto: SuggestGlossaryTermsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SuggestGlossaryTermsResponse> {
    // The extractor reads the page, so the caller must be able to open it (#712).
    // Here, not in the service: the glossarist agent calls `suggest` over pages
    // its run scope already filtered.
    if (dto.documentId) {
      const scope = await this.permissions.scopeFor(principal, dto.workspaceId);
      await this.permissions.requireLevel(scope, { type: 'document', id: dto.documentId }, 'view');
    }
    return this.glossary.suggest(dto, principal);
  }

  @Get(':id')
  @Returns('GlossaryTerm')
  @Access('viewer', 'glossary-term')
  @ApiOperation({ summary: 'One glossary entry' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<GlossaryTerm> {
    return this.glossary.get(id, await this.termScope(principal, id));
  }

  @Patch(':id')
  @Returns('GlossaryTerm')
  @Access('editor', 'glossary-term')
  @ApiOperation({ summary: 'Edit a term, its aliases, its definition or its defining page' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGlossaryTermDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GlossaryTerm> {
    return this.glossary.update(id, dto, await this.termScope(principal, id), principal?.userId);
  }

  @Delete(':id')
  @Access('editor', 'glossary-term')
  @ApiOperation({ summary: 'Remove a term; pages that mention it simply stop linking it' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ deleted: true }> {
    return this.glossary.remove(id, principal?.userId);
  }
}
