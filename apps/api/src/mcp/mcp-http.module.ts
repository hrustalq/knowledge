import { Module } from '@nestjs/common';
import { CollabModule } from '../collab/collab.module.js';
import { McpCoreModule } from './mcp-core.module.js';
import { McpController } from './mcp.controller.js';

/**
 * POST /v1/mcp and the connection page's endpoints (docs/features/33).
 * API-only, which is what lets it offer the draft tools: CollabModule's
 * gateway is in this process and nowhere else (#316).
 */
@Module({
  imports: [McpCoreModule, CollabModule],
  controllers: [McpController],
})
export class McpHttpModule {}
