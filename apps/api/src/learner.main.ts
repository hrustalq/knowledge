import { NestFactory } from '@nestjs/core';
import { LearnerModule } from './learner/learner.module.js';
import { createRootLogger, envLogLevel } from '@knowledge/observability';
import { PinoNestLogger } from './observability/nest-logger.js';

/**
 * The fifth entrypoint (#305): the learner. An application context like the
 * worker — no HTTP listener — whose only provider that does anything is the
 * `LearnerTicker`. With LEARNER_ENABLED=false (the default) it boots, says so
 * and idles, so a container started without the flag neither works nor
 * crash-loops.
 */
async function bootstrap() {
  const logger = createRootLogger({ service: 'learner', level: envLogLevel() });
  const app = await NestFactory.createApplicationContext(LearnerModule, { bufferLogs: true });
  app.useLogger(new PinoNestLogger(logger));
  app.enableShutdownHooks();
  logger.info('Learner started');
}
await bootstrap();
