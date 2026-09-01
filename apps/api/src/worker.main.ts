import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  // Application context only — no HTTP listener. BullMQ processors run as providers.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  console.log('Ingestion worker started');
}
await bootstrap();
