import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProvidersService } from './ai-providers.service.js';
import { AiUsageService } from './ai-usage.service.js';
import { AiSkillsService } from './ai-skills.service.js';

/**
 * Provider resolution and token accounting, with no controllers and no auth
 * dependencies — so the worker can import it.
 *
 * The split exists because relation extraction runs in the worker but is
 * routed by the same per-workspace provider profiles the API uses
 * (docs/features/12). Same shape as EventsModule / EventsApiModule: the
 * publisher half is worker-safe, the controller half is not.
 *
 * AiSkillsService lives here for the same reason (it needs only Prisma): a
 * workflow step and a background agent both carry `skillIds`, and rendering
 * them anywhere but through this service is how feature 17 ended up with a
 * second copy of the `<skills>` block.
 */
@Module({
  imports: [PrismaModule],
  providers: [AiProvidersService, AiConfigService, AiUsageService, AiSkillsService],
  exports: [AiProvidersService, AiConfigService, AiUsageService, AiSkillsService],
})
export class AiCoreModule {}
