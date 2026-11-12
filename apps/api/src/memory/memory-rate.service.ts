import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PublicRateLimiter, RateLimitedException } from '../public/public-rate-limit.js';

export type MemoryVerb = 'retain' | 'recall' | 'reflect';

/**
 * The per-key rate of each memory verb (#998), asked by every door — the REST
 * routes and the per-bank MCP tools — after the resolver and before the work.
 * Per key, or per person without one.
 *
 * What a Redis outage means differs by what the call costs: retain and recall
 * stay up (an agent must not stop remembering), reflect does not — it is a
 * model call on a viewer's request, and an unbounded one is a bill.
 *
 * API-only: the limiter is the API's.
 */
@Injectable()
export class MemoryRateService {
  private readonly perMin: Record<MemoryVerb, number>;

  constructor(
    private readonly limiter: PublicRateLimiter,
    config: ConfigService<Env, true>,
  ) {
    this.perMin = {
      retain: config.get('MEMORY_RETAIN_RATE_PER_MIN', { infer: true }),
      recall: config.get('MEMORY_RECALL_RATE_PER_MIN', { infer: true }),
      reflect: config.get('MEMORY_REFLECT_RATE_PER_MIN', { infer: true }),
    };
  }

  async check(verb: MemoryVerb, principal: Principal): Promise<void> {
    const within = await this.limiter.hit(`memory:${verb}:${principal.apiKey?.id ?? principal.userId}`, this.perMin[verb], 60_000, verb !== 'reflect');
    if (!within) throw new RateLimitedException(t('error.memory.rateLimited', { verb }), 60, 'memory.rateLimited');
  }
}
