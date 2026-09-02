import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { createOpenApiDocument } from './config/swagger.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Live tracked-entity updates: plain `ws` adapter for the /v1/events/ws gateway.
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Strict error contract: every non-2xx response is an ApiErrorPayload envelope.
  app.useGlobalFilters(new ApiExceptionFilter());

  SwaggerModule.setup('docs', app, createOpenApiDocument(app));

  await app.listen(process.env.PORT ?? 3000);
  console.log(`API listening on :${process.env.PORT ?? 3000} (Swagger at /docs)`);
}
await bootstrap();
