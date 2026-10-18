import { Injectable, NotFoundException, type CanActivate } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { t } from '../../i18n/t.js';
import { scimEnabled } from '../../scim/scim-enabled.js';

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
    this.on = ssoEnabled(config);
  }

  canActivate(): boolean {
    if (!this.on) throw new NotFoundException(t('error.sso.disabled'));
    return true;
  }
}

export function ssoEnabled(config: ConfigService<Env, true>): boolean {
  return config.get('AUTH_SSO_ENABLED', { infer: true }) && config.get('AUTH_MODE', { infer: true }) === 'api-key';
}

/**
 * Group mappings serve sign-in sync and SCIM alike (#75), so their routes
 * answer while either is on; the service refuses the kind that is off.
 */
@Injectable()
export class SsoOrScimEnabledGuard implements CanActivate {
  private readonly on: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.on = ssoEnabled(config) || scimEnabled(config);
  }

  canActivate(): boolean {
    if (!this.on) throw new NotFoundException(t('error.sso.disabled'));
    return true;
  }
}
