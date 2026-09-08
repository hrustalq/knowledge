import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProvidersService } from './ai-providers.service.js';
import { AiUsageService } from './ai-usage.service.js';

/**
 * Provider resolution and token accounting, with no controllers and no auth
 * dependencies — so the worker can import it.
 *
 * The split exists because relation extraction runs in the worker but is
 * routed by the same per-workspace provider profiles the API uses
 * (docs/features/12). Same shape as EventsModule / EventsApiModule: the
 * publisher half is worker-safe, the controller half is not.
 */
@Module({
  imports: [PrismaModule],
  providers: [AiProvidersService, AiConfigService, AiUsageService],
  exports: [AiProvidersService, AiConfigService, AiUsageService],
})
export class AiCoreModule {}
