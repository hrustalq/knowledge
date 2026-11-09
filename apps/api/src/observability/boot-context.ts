import type { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createRootLogger, envLogLevel, type AppLogger, type ServiceName } from '@knowledge/observability';
import { PinoNestLogger } from './nest-logger.js';

/**
 * An entrypoint with no HTTP listener (the worker, the learner, the MCP
 * server): its pino root logger behind Nest's, buffered until it is attached,
 * and shutdown hooks on. `stream` and `abortOnError` are the MCP server's.
 */
export async function bootContext(
  module: Type<unknown>,
  service: ServiceName,
  opts: { stream?: Parameters<typeof createRootLogger>[0]['stream']; abortOnError?: boolean } = {},
): Promise<{ app: INestApplicationContext; logger: AppLogger }> {
  const logger = createRootLogger({ service, level: envLogLevel(), ...(opts.stream ? { stream: opts.stream } : {}) });
  const app = await NestFactory.createApplicationContext(module, {
    bufferLogs: true,
    ...(opts.abortOnError === undefined ? {} : { abortOnError: opts.abortOnError }),
  });
  app.useLogger(new PinoNestLogger(logger));
  app.enableShutdownHooks();
  return { app, logger };
}
