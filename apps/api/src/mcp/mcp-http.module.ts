import { Module } from '@nestjs/common';
import { McpCoreModule } from './mcp-core.module.js';
import { McpController } from './mcp.controller.js';

/** POST /v1/mcp and the connection page's endpoints (docs/features/33). API-only. */
@Module({
  imports: [McpCoreModule],
  controllers: [McpController],
})
export class McpHttpModule {}
