import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

/**
 * SCIM answers only with AUTH_SCIM_ENABLED under AUTH_MODE=api-key (#75).
 * Under `none` the dev principal is everyone, so provisioning people would
 * change nothing anyone can observe.
 */
export function scimEnabled(config: ConfigService<Env, true>): boolean {
  return config.get('AUTH_SCIM_ENABLED', { infer: true }) && config.get('AUTH_MODE', { infer: true }) === 'api-key';
}

/**
 * Each write commits with the role sync and offboarding it demands (#656). A group push
 * re-syncs every member one at a time, which can outrun the 5 s default.
 * ponytail: one transaction per push; batch reconcile if a group of thousands outgrows 30 s.
 */
export const SCIM_TX = { timeout: 30_000, maxWait: 10_000 };
