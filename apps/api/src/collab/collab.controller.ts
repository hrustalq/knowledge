import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CollabCapabilitiesResponse } from '@knowledge/contracts';
import { SCHEMA_VERSION } from '@knowledge/editor-schema';
import type { Env } from '../config/env.js';

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
