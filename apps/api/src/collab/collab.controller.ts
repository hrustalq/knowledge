import { Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CollabCapabilitiesResponse, ListCollabDraftsResponse } from '@knowledge/contracts';
import { SCHEMA_VERSION } from '@knowledge/editor-schema';
import { Access } from '../auth/access.decorator.js';
import type { Env } from '../config/env.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t } from '../i18n/t.js';
import { CollabDraftsService } from './collab-drafts.service.js';
import { CollabGateway } from './collab.gateway.js';

/**
 * What a client asks before it opens `/v1/collab` (#80, docs/features/56).
 * Authenticated only: it names no workspace and tells nothing about one, so
 * there is nothing for `@Access` to resolve. The socket URL is not here: the
 * client derives it the way `api/live.ts` does, because behind the proxy the
 * API cannot see the address the browser used.
 */
@ApiTags('collab')
@Controller('v1/collab')
export class CollabController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get('capabilities')
  @ApiOperation({
    summary: 'Whether this deployment co-edits drafts, and the editor schema version a peer must match to write',
  })
  capabilities(): CollabCapabilitiesResponse {
    return { enabled: this.config.get('COLLAB_ENABLED', { infer: true }), schemaVersion: SCHEMA_VERSION };
  }
}

/** A page's shared drafts, one per branch that has been opened in the editor. */
@ApiTags('collab')
@Controller('v1/documents')
export class CollabDraftsController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly drafts: CollabDraftsService,
    private readonly gateway: CollabGateway,
    private readonly events: EventsPublisher,
  ) {}

  @Get(':id/drafts')
  @Access('viewer', 'document')
  @ApiOperation({
    summary: "Each branch's shared draft: its base, whether it holds unpublished changes, who wrote them, who has it open",
  })
  async list(@Param('id', ParseUUIDPipe) id: string): Promise<ListCollabDraftsResponse> {
    if (!this.config.get('COLLAB_ENABLED', { infer: true })) return { drafts: [] };
    return { drafts: await this.drafts.list(id, (workspaceId, branchId) => this.gateway.peersOf(workspaceId, id, branchId)) };
  }

  @Delete(':id/drafts/:branchId')
  @Access('editor', 'document')
  @HttpCode(204)
  @ApiOperation({
    summary: "Discard a branch's shared draft: it is reseeded from the branch head, and everyone in it rejoins (reason `reset`)",
  })
  async reset(@Param('id', ParseUUIDPipe) id: string, @Param('branchId', ParseUUIDPipe) branchId: string): Promise<void> {
    const workspaceId = await this.drafts.workspaceOfBranch(id, branchId);
    if (!workspaceId || !(await this.drafts.reset(id, branchId))) {
      throw new NotFoundException(t('error.collab.draftNotFound', { documentId: id, branchId }));
    }
    // Every instance closes its own peers on this (CollabGateway); a lost
    // event leaves them to the refused store, which closes them too.
    await this.events.publish({ type: 'draft.reset', workspaceId, documentId: id, subjectId: branchId });
  }
}
