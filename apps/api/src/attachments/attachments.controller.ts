import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CompleteAttachmentResponse,
  CreateAttachmentResponse,
  ListAttachmentsResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CreateAttachmentDto } from './attachments.dto.js';
import { AttachmentsService } from './attachments.service.js';

/**
 * Page attachments for the rich editor. The ACL source is `document`, so the
 * guard resolves `:id` to its owning workspace before anything here runs — an
 * attachment id from another tenant cannot be reached even by guessing.
 *
 * Reads are a redirect rather than a proxy: `<img>` and `<object>` cannot send
 * an Authorization header, so the API authorizes the request (AuthGuard also
 * accepts `?token=`, same as SSE) and then hands the browser a short-lived
 * presigned URL instead of streaming megabytes through Node.
 */
@ApiTags('attachments')
@Controller('v1/documents/:id/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'List a page’s attachments' })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<ListAttachmentsResponse> {
    return this.attachments.list(id);
  }

  @Post()
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Reserve an attachment and get a presigned upload URL' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAttachmentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateAttachmentResponse> {
    return this.attachments.create(id, dto, principal?.userId);
  }

  @Post(':attachmentId/complete')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Confirm the upload landed; marks the attachment ready' })
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<CompleteAttachmentResponse> {
    return this.attachments.complete(id, attachmentId);
  }

  @Get(':attachmentId/content')
  @Access('viewer', 'document')
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint() // binary redirect; not useful in the generated client
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query('download') download?: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.attachments.readUrl(id, attachmentId, download === '1' || download === 'true');
    return { url, statusCode: 302 };
  }

  @Delete(':attachmentId')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Delete an attachment and its object' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<{ deleted: true }> {
    return this.attachments.remove(id, attachmentId);
  }
}
