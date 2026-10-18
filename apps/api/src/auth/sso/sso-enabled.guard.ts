import { Injectable, NotFoundException, type CanActivate } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { t } from '../../i18n/t.js';

/**
 * Every SSO route answers 404 unless AUTH_SSO_ENABLED is on and the instance
 * runs AUTH_MODE=api-key (#75). Under `none` the dev principal is everyone,
 * so a provider would have nobody to sign in; under SSO off the instance is
 * exactly the password + key flow, routes included.
 */
@Injectable()
export class SsoEnabledGuard implements CanActivate {
  private readonly on: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.on = config.get('AUTH_SSO_ENABLED', { infer: true }) && config.get('AUTH_MODE', { infer: true }) === 'api-key';
  }

  canActivate(): boolean {
    if (!this.on) throw new NotFoundException(t('error.sso.disabled'));
    return true;
  }
}
