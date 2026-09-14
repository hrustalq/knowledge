import { NestFactory } from '@nestjs/core';
import { McpModule } from './mcp/mcp.module.js';
import { McpService } from './mcp/mcp.service.js';
import { createRootLogger, envLogLevel, stderrStream } from '@knowledge/observability';
import { PinoNestLogger } from './observability/nest-logger.js';

async function bootstrap() {
  // Logging goes to stderr, never stdout: stdout belongs to the MCP stdio
  // transport (JSON-RPC frames only) and a single stray byte corrupts it.
  //
  // This process used to run with `logger: false`, which silenced not just this
  // file but every logger in every module it imports — most of the app. Pointing
  // pino at fd 2 is what makes the MCP surface debuggable without touching the
  // transport. sync so records are flushed before an exit path can drop them.
  const logger = createRootLogger({
    service: 'mcp',
    level: envLogLevel(),
    stream: stderrStream(),
  });

  // abortOnError:false → boot errors reject instead of being logged + silent exit.
  const app = await NestFactory.createApplicationContext(McpModule, { bufferLogs: true, abortOnError: false });
  app.useLogger(new PinoNestLogger(logger));
  app.enableShutdownHooks();
  await app.get(McpService).serveStdio();
  logger.info('knowledge MCP server listening on stdio');
}

await bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
