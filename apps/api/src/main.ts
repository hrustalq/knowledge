import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { validationExceptionFactory } from './common/validation.js';
import { createOpenApiDocument } from './config/swagger.js';
import { createRootLogger, envLogLevel } from '@knowledge/observability';
import { traceMiddleware } from '@knowledge/observability/express';
import { PinoNestLogger } from './observability/nest-logger.js';

async function bootstrap() {
  // Built before Nest so boot-time records are structured too. LOG_LEVEL is read
  // from process.env rather than ConfigService: DI does not exist yet. env.ts
  // still declares it, so a bad value fails boot rather than silently defaulting.
  const logger = createRootLogger({ service: 'api', level: envLogLevel() });

  // rawBody: connector webhooks (docs/features/19) verify an HMAC over the
  // exact bytes sent; re-serialising the parsed body would not reproduce them.
  // bufferLogs: hold Nest's own boot output until useLogger below, or it would
  // bypass pino and print unstructured.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  // Routes all 54 existing `new Logger(X.name)` declarations through pino, each
  // record picking up the active trace context from the logger's mixin.
  app.useLogger(new PinoNestLogger(logger));

  // Ahead of the router, so an unmatched path is traced and counted too.
  app.use(traceMiddleware);

  // The app had no body parser configured at all, so it silently inherited
  // Express's 100 kB default: a pasted page, a long comment or an import submit
  // died inside body-parser as an untranslated 500 (see ApiExceptionFilter).
  //
  // This REPLACES the framework's default registration rather than adding to it
  // (`registerParserMiddleware` skips a parser already applied), and it keeps
  // `rawBody` working: useBodyParser forwards the app's rawBody option, which
  // reattaches the verify hook the connector webhook HMAC depends on. Registered
  // after traceMiddleware so an oversize body is rejected inside a trace scope
  // and its 413 carries a requestId that correlates.
  //
  // The ?? is unreachable — env.ts defaults it — but ConfigService cannot prove
  // that to the compiler.
  const bodyLimit = app.get(ConfigService).get<string>('HTTP_BODY_LIMIT') ?? '2mb';
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });
  // Live tracked-entity updates: plain `ws` adapter for the /v1/events/ws gateway.
  app.useWebSocketAdapter(new WsAdapter(app));
  // exceptionFactory translates class-validator failures while keeping the
  // existing details.errors: string[] shape (docs/features/18).
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, exceptionFactory: validationExceptionFactory }),
  );
  // Strict error contract: every non-2xx response is an ApiErrorPayload envelope.
  app.useGlobalFilters(new ApiExceptionFilter());

  SwaggerModule.setup('docs', app, createOpenApiDocument(app));

  // worker.main.ts and mcp.main.ts both do this; the API did not, so on SIGTERM
  // it skipped every OnModuleDestroy — no sweeper timer cleared, no Redis
  // client disconnected, no in-flight request drained.
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
  logger.info(
    { port: Number(process.env.PORT ?? 3000), docs: '/docs' },
    `API listening on :${process.env.PORT ?? 3000} (Swagger at /docs)`,
  );
}
await bootstrap();
