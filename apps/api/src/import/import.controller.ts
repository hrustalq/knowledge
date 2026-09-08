import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateImportResponse,
  ImportContentResponse,
  ImportJobResponse,
  SubmitImportResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CreateImportDto, SubmitImportDto } from './dto/imports.dto.js';
import { ImportService } from './import.service.js';

/**
 * Document import (docs/features/16).
 *
 * The ACL source is `import` on every `:id` route, so the guard resolves the
 * owning workspace in Postgres before the handler runs — another tenant's
 * import id is a 403 even though the row exists and even though no document
 * exists yet to hang permissions off.
 */
@ApiTags('imports')
@Controller('v1/imports')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Post()
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Reserve an import and get a presigned upload URL' })
  create(
    @Body() dto: CreateImportDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateImportResponse> {
    return this.imports.create(dto, principal?.userId);
  }

  @Post(':id/start')
  @Access('editor', 'import')
  @ApiOperation({ summary: 'Confirm the upload landed and queue the parse' })
  async start(@Param('id', ParseUUIDPipe) id: string): Promise<ImportJobResponse> {
    return { import: await this.imports.start(id) };
  }

  @Get(':id')
  @Access('viewer', 'import')
  @ApiOperation({ summary: 'Import status — polled by the wizard while parsing' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ImportJobResponse> {
    return { import: await this.imports.get(id) };
  }

  @Get(':id/content')
  @Access('viewer', 'import')
  @ApiOperation({ summary: 'The parsed markdown, for the review step' })
  content(@Param('id', ParseUUIDPipe) id: string): Promise<ImportContentResponse> {
    return this.imports.content(id);
  }

  /**
   * Images the parser lifted out of the source, served exactly like page
   * attachments are: authorize here, then redirect to a short-lived presigned
   * URL rather than streaming bytes through Node. `<img>` cannot send an
   * Authorization header, which is why AuthGuard also accepts `?token=`.
   */
  @Get(':id/images/:index')
  @Access('viewer', 'import')
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint() // binary redirect; not useful in the generated client
  async image(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<{ url: string; statusCode: number }> {
    return { url: await this.imports.imageUrl(id, index), statusCode: 302 };
  }

  @Post(':id/submit')
  @Access('editor', 'import')
  @ApiOperation({ summary: 'Create the page from the reviewed result, keeping the original as an attachment' })
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitImportDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SubmitImportResponse> {
    return this.imports.submit(id, dto, principal?.userId);
  }

  @Delete(':id')
  @Access('editor', 'import')
  @ApiOperation({ summary: 'Discard an import and its staged files' })
  discard(@Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: true }> {
    return this.imports.discard(id);
  }
}
