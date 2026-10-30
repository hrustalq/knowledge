import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createRootLogger, envLogLevel } from '@knowledge/observability';
import { traceMiddleware } from '@knowledge/observability/express';
import type { Env } from './config/env.js';
import { GitModule } from './git/git.module.js';
import { PinoNestLogger } from './observability/nest-logger.js';

/**
 * The sixth entrypoint (#636, docs/features/71): a project as a git remote.
 * Smart HTTP behind `/git/*` in the Caddyfile. No body parser: a pack request
 * is piped to `git upload-pack` as it arrives. With GIT_REMOTE_ENABLED=false
 * (the default) it boots and answers 404, so a container started without the
 * flag neither serves nor crash-loops.
 */
async function bootstrap() {
  const logger = createRootLogger({ service: 'git', level: envLogLevel() });
  const app = await NestFactory.create<NestExpressApplication>(GitModule, { bodyParser: false, bufferLogs: true });
  app.useLogger(new PinoNestLogger(logger));
  app.use(traceMiddleware);
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Env, true>);
  const port = config.get('GIT_PORT', { infer: true });
  await app.listen(port);
  logger.info({ msg: 'Git remote listening', port, enabled: config.get('GIT_REMOTE_ENABLED', { infer: true }) });
}
await bootstrap();
