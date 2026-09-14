import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { validationExceptionFactory } from './common/validation.js';
import { createOpenApiDocument } from './config/swagger.js';

async function bootstrap() {
  // rawBody: connector webhooks (docs/features/19) verify an HMAC over the
  // exact bytes sent; re-serialising the parsed body would not reproduce them.
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
  console.log(`API listening on :${process.env.PORT ?? 3000} (Swagger at /docs)`);
}
await bootstrap();
