import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { WebResearchService } from './web-research.service.js';

/**
 * The two web tools, loadable from either process (docs/features/29).
 *
 * `WebResearchService` was provided by `AssistantModule` alone, and the only
 * thing that reached it was `AssistantToolsService` — which injects
 * DocumentsService, MergeRequestsService and StorageService and so can never
 * load in the worker. The effect was that a background agent could not reach the
 * web at all, however it was configured.
 *
 * Nothing about the service required that: it takes `ConfigService` and
 * `SourcePolicyService`, and the latter has lived in the controller-free
 * `AiCoreModule` since feature 25 precisely because the fetch decision has to be
 * the same one the settings page writes rows for. This is the split
 * `AiCoreModule` and `GlossaryCoreModule` already established, applied to the
 * one service that was left behind.
 *
 * `AgentWorkerModule` imports this even though no runnable agent calls the web
 * yet. That is deliberate and not dead wiring: Nest instantiates an imported
 * module's providers at boot, so the worker constructs this service on every
 * start, and the day someone adds an API-only dependency to it the worker fails
 * loudly at boot instead of at the first tool call in a background run.
 */
@Module({
  imports: [AiCoreModule],
  providers: [WebResearchService],
  exports: [WebResearchService],
})
export class WebResearchModule {}
