import { WorkerModule } from './worker.module.js';
import { bootContext } from './observability/boot-context.js';

async function bootstrap() {
  // Application context only — no HTTP listener. BullMQ processors run as providers.
  const { logger } = await bootContext(WorkerModule, 'worker');
  logger.info('Ingestion worker started');
}
await bootstrap();
