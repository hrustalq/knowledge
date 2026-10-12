import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { validationExceptionFactory } from '../src/common/validation.js';

/**
 * The HTTP app the way `src/main.ts` builds it: the `ws` adapter (without it
 * `init()` exits the process looking for socket.io), the global validation
 * pipe and the error filter. `extraImports` lets a spec add a worker-side
 * module — an ingestion consumer, say — so a write can be followed to
 * `indexed` without depending on whether `make dev`'s worker is up.
 *
 * e2e specs run against live infra (`make infra-up`, apps/api/.env) and are
 * not part of `make verify` or CI: `pnpm --filter @knowledge/api run test:e2e`.
 */
export async function createE2eApp(extraImports: unknown[] = []): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(extraImports as never[])],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, exceptionFactory: validationExceptionFactory }));
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  return app;
}
