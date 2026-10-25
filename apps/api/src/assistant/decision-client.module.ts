import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { DecisionClient } from './decision.client.js';

/**
 * The decision model's client on its own (#530), shaped like
 * `AssistantClientModule`: no controllers, so the worker (the arbiter) and the
 * API (citation support, harvest) can both import it.
 */
@Module({
  imports: [AiCoreModule],
  providers: [DecisionClient],
  exports: [DecisionClient],
})
export class DecisionClientModule {}
