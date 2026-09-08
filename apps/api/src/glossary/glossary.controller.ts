import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
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

/**
 * Glossary (docs/features/14). Reading is `viewer` because every reader needs
 * the roster — the term linker runs on every rendered page — and writing is
 * `editor`, the same bar as editing the documents the vocabulary describes.
 */
@ApiTags('glossary')
@Controller('v1/glossary')
export class GlossaryController {
  constructor(private readonly glossary: GlossaryService) {}

  @Get()
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'projectId', required: false, description: 'Restrict to one project' })
  @ApiOperation({
    summary:
      'The glossary — the roster the read-side term linker matches against. ' +
      'Scoped to one project with projectId; without it, the whole workspace.',
  })
  list(@Query() query: ListGlossaryQueryDto): Promise<ListGlossaryResponse> {
    return this.glossary.list(query);
  }

  @Post()
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Add a term to a project (409 when that project already defines it)' })
  create(
    @Body() dto: CreateGlossaryTermDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GlossaryTerm> {
    return this.glossary.create(dto, principal?.userId);
  }

  /**
   * Declared before `:id` — Nest matches in declaration order, so a literal
   * segment sharing the prefix has to come first (same reason
   * `GET /v1/documents/tree` precedes `GET /v1/documents/:id`).
   */
  @Post('suggest')
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      'LLM term extraction over a page or a draft — proposals only, nothing is saved; ' +
      'enabled=false when the assistant provider is none',
  })
  suggest(
    @Body() dto: SuggestGlossaryTermsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SuggestGlossaryTermsResponse> {
    return this.glossary.suggest(dto, principal);
  }

  @Get(':id')
  @Access('viewer', 'glossary-term')
  @ApiOperation({ summary: 'One glossary entry' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<GlossaryTerm> {
    return this.glossary.get(id);
  }

  @Patch(':id')
  @Access('editor', 'glossary-term')
  @ApiOperation({ summary: 'Edit a term, its aliases, its definition or its defining page' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGlossaryTermDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GlossaryTerm> {
    return this.glossary.update(id, dto, principal?.userId);
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
