import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ArchiveDocumentResponse, DocumentDetailResponse } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ArchiveDocumentDto, FlagDocumentDto, VerifyDocumentDto } from './verification.dto.js';
import { VerificationService } from './verification.service.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * A page's verification state, by hand (docs/features/39, issue #66).
 *
 * Mounted on `v1/documents` beside `DocumentsController`: every route here is
 * `:id/<literal>`, so there is no ordering hazard with its `@Get(':id')`.
 * Roles mirror the comment routes — asking for a check is `viewer` (anyone who
 * may read may ask), everything that asserts something about the content is
 * `editor`. No route admits a read-only key.
 */
@ApiTags('documents')
@Controller('v1/documents')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Post(':id/verify')
  @Returns('DocumentDetailResponse')
  @Access('editor', 'document')
  @ApiOperation({
    summary:
      'Stamp the page as verified at its current head (docs/features/39). Clears any requested/outdated flag; ' +
      'optionally sets the review interval. The stamp reads as edited once the head moves and expired past its ' +
      'interval, with nothing written',
  })
  @ApiResponse({ status: 409, description: 'No finalized head to vouch for (no_head_revision), or the page is archived (document_archived)' })
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentDetailResponse> {
    return this.verification.verify(id, principal.userId, { intervalDays: dto.intervalDays });
  }

  @Delete(':id/verify')
  @Returns('DocumentDetailResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Back to unverified: remove the stamp and any requested/outdated flag' })
  clear(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<DocumentDetailResponse> {
    return this.verification.clear(id, principal.userId);
  }

  @Post(':id/verification-request')
  @Returns('DocumentDetailResponse')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Ask for the page to be checked. Notifies the owner (or the last verifier)' })
  @ApiResponse({ status: 409, description: 'The page is archived' })
  async request(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FlagDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentDetailResponse> {
    return (await this.verification.requestVerification(id, { actorId: principal.userId, note: dto.note }))!;
  }

  @Post(':id/outdated')
  @Returns('DocumentDetailResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Declare the page outdated. Ranks it last in search until verified or cleared; notifies the owner' })
  @ApiResponse({ status: 409, description: 'The page is archived' })
  async outdated(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FlagDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DocumentDetailResponse> {
    return (await this.verification.markOutdated(id, { actorId: principal.userId, note: dto.note }))!;
  }

  @Post(':id/archive')
  @Returns('ArchiveDocumentResponse')
  @Access('editor', 'document')
  @ApiOperation({
    summary:
      'Archive the page and (by default) its subtree in one statement. Hidden from lists, tree, search, ask and ' +
      'MCP unless asked for; still readable by id; writes return 409 document_archived until unarchived',
  })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchiveDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ArchiveDocumentResponse> {
    return this.verification.archive(id, principal.userId, dto.includeDescendants ?? true);
  }

  @Post(':id/unarchive')
  @Returns('ArchiveDocumentResponse')
  @Access('editor', 'document')
  @ApiOperation({ summary: 'Restore an archived page and (by default) its subtree' })
  unarchive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchiveDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ArchiveDocumentResponse> {
    return this.verification.unarchive(id, principal.userId, dto.includeDescendants ?? true);
  }
}
