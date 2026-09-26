import { Module } from '@nestjs/common';
import { BootstrapModule } from '../config/bootstrap.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { McpCoreModule } from './mcp-core.module.js';

/**
 * MCP stdio entrypoint module (plan.md §9), started via mcp.main.ts: no HTTP
 * listener. The tools live in McpCoreModule; the API serves the same ones over
 * Streamable HTTP through McpHttpModule.
 */
@Module({
  imports: [BootstrapModule, AuthModule, McpCoreModule],
})
export class McpModule {}
