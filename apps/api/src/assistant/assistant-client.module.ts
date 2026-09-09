import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClient } from './assistant.client.js';

/**
 * The provider client on its own, with nothing else attached.
 *
 * `AssistantClient` needs only `AiUsageService`, but `AssistantModule` — the
 * only thing that used to export it — carries the controller and pulls
 * `DocumentsModule`, so every worker-side module that wanted a model call
 * listed `providers: [AssistantClient]` itself. That worked, and it meant each
 * one built its own instance with its own SDK cache.
 *
 * One module instead, importable from either process. Same shape as the other
 * Core splits: no controllers, nothing that reaches for AccessService.
 */
@Module({
  imports: [AiCoreModule],
  providers: [AssistantClient],
  exports: [AssistantClient],
})
export class AssistantClientModule {}
