import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { createRootLogger, envLogLevel } from '@knowledge/observability';
import { PinoNestLogger } from './observability/nest-logger.js';

async function bootstrap() {
  const logger = createRootLogger({ service: 'worker', level: envLogLevel() });

  // Application context only — no HTTP listener. BullMQ processors run as providers.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(new PinoNestLogger(logger));
  app.enableShutdownHooks();
  logger.info('Ingestion worker started');
}
await bootstrap();
