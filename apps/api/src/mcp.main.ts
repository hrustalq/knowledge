import { NestFactory } from '@nestjs/core';
import { McpModule } from './mcp/mcp.module.js';
import { McpService } from './mcp/mcp.service.js';

async function bootstrap() {
  // Application context only — no HTTP listener. Nest logging is disabled:
  // stdout belongs to the MCP stdio transport (JSON-RPC frames only).
  // abortOnError:false → boot errors reject instead of being logged (logger off) + silent exit.
  const app = await NestFactory.createApplicationContext(McpModule, { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  await app.get(McpService).serveStdio();
  console.error('knowledge MCP server listening on stdio');
}

await bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
