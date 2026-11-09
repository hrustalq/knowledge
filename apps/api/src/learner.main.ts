import { LearnerModule } from './learner/learner.module.js';
import { bootContext } from './observability/boot-context.js';

/**
 * The fifth entrypoint (#305): the learner. An application context like the
 * worker — no HTTP listener — whose only provider that does anything is the
 * `LearnerTicker`. With LEARNER_ENABLED=false (the default) it boots, says so
 * and idles, so a container started without the flag neither works nor
 * crash-loops.
 */
async function bootstrap() {
  const { logger } = await bootContext(LearnerModule, 'learner');
  logger.info('Learner started');
}
await bootstrap();
