import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityProvider } from '@prisma/client';
import * as client from 'openid-client';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { OidcProviderConfig, TestIdentityProviderResponse } from '@knowledge/contracts';
import { decryptSecret, parseKey } from '../../ai/secret-box.js';
import { safeFetch } from '../../common/safe-fetch.js';
import type { Env } from '../../config/env.js';
import { identityFromClaims, identityFromYandex, type ClaimsResult } from './oidc-claims.js';
import { OIDC_PRESETS, presetOf } from './oidc-presets.js';

/** What the login transaction remembers between start and callback. */
export interface OidcChecks {
  state: string;
  /** Null for an OAuth 2 preset, which has no id_token to carry one. */
  nonce: string | null;
  codeVerifier: string;
}

/** A discovery document changes rarely; ten minutes keeps a login from paying for it every time. */
const DISCOVERY_TTL_MS = 10 * 60_000;
/** Seconds: an IdP that does not answer fails the login, it does not hang it. */
const HTTP_TIMEOUT_SEC = 10;
/** Back-Channel Logout 1.0 §2.4: the `events` member a logout token must carry. */
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** A logout token older than this is refused: the OP sends it the moment the session ends. */
export const LOGOUT_TOKEN_MAX_AGE_SEC = 600;

/** Who a verified logout token ends: one IdP session (`sid`), every session of one subject (`sub`), or both narrowed. */
export interface LogoutClaims {
  sid: string | null;
  sub: string | null;
  jti: string | null;
}

export function oidcConfigOf(provider: Pick<IdentityProvider, 'config'>): OidcProviderConfig {
  const raw = (provider.config ?? {}) as Record<string, unknown>;
  return {
    issuer: typeof raw.issuer === 'string' ? raw.issuer : '',
    clientId: typeof raw.clientId === 'string' ? raw.clientId : '',
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s): s is string => typeof s === 'string') : [],
  };
}

/**
 * OpenID Connect for one provider row (#75): discovery, the authorization URL,
 * and the code exchange whose result `SsoLoginService` decides on.
 *
 * Every request the library makes goes through `safeFetch`, so an issuer, a
 * token endpoint or a JWKS URL a discovery document names cannot be pointed
 * at a private address unless AUTH_SSO_ALLOW_PRIVATE_URLS says this is an
 * on-prem IdP. The check runs inside the connection's own DNS lookup, which
 * is what makes a discovery document that names `127.0.0.1` harmless.
 */
@Injectable()
export class OidcService {
  private readonly key: Buffer | null;
  private readonly allowPrivate: boolean;
  private readonly apiBase: string;
  private readonly cache = new Map<string, { stamp: string; at: number; config: client.Configuration }>();
  /** jose caches the keys and refetches on an unknown `kid`; one set per provider and JWKS URL. */
  private readonly jwks = new Map<string, { uri: string; keys: JWTVerifyGetKey }>();

  constructor(config: ConfigService<Env, true>) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivate = config.get('AUTH_SSO_ALLOW_PRIVATE_URLS', { infer: true });
    this.apiBase = config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
  }

  /** What an admin registers at the IdP, and what the code is redeemed against. */
  redirectUri(providerId: string): string {
    return `${this.apiBase}/v1/auth/oidc/${providerId}/callback`;
  }

  /** Where the IdP posts logout tokens. Null for an OAuth 2 preset, which issues no id_token to end. */
  backchannelLogoutUri(provider: Pick<IdentityProvider, 'id' | 'preset'>): string | null {
    return OIDC_PRESETS[presetOf(provider.preset)].oauth2 ? null : `${this.apiBase}/v1/auth/oidc/${provider.id}/backchannel-logout`;
  }

  /**
   * Verify a back-channel logout token (OIDC Back-Channel Logout 1.0 §2.6):
   * signed by a key from the provider's JWKS, issued by it, for our client,
   * recent, carrying the logout event, naming a `sid` or a `sub`, and never a
   * `nonce` — which is what keeps an id_token from being replayed as one.
   * Throws with the reason, which only the audit row sees.
   */
  async logoutClaims(provider: IdentityProvider, token: string): Promise<LogoutClaims> {
    if (OIDC_PRESETS[presetOf(provider.preset)].oauth2) throw new Error('this preset has no back-channel logout');
    const meta = (await this.configuration(provider)).serverMetadata();
    if (!meta.jwks_uri) throw new Error('the discovery document names no jwks_uri');
    let hit = this.jwks.get(provider.id);
    if (!hit || hit.uri !== meta.jwks_uri) {
      hit = {
        uri: meta.jwks_uri,
        keys: createRemoteJWKSet(new URL(meta.jwks_uri), {
          timeoutDuration: HTTP_TIMEOUT_SEC * 1000,
          [customFetch]: (url, options) => safeFetch(url, options as unknown as RequestInit, this.allowPrivate),
        }),
      };
      this.jwks.set(provider.id, hit);
    }
    const { payload } = await jwtVerify(token, hit.keys, {
      issuer: meta.issuer,
      audience: oidcConfigOf(provider).clientId,
      maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SEC,
      clockTolerance: 60,
    });
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object' || typeof events[BACKCHANNEL_EVENT] !== 'object' || events[BACKCHANNEL_EVENT] === null) {
      throw new Error('no back-channel logout event');
    }
    if (payload.nonce !== undefined) throw new Error('a logout token carries no nonce');
    const sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : null;
    const sub = typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
    if (!sid && !sub) throw new Error('neither sid nor sub');
    return { sid, sub, jti: typeof payload.jti === 'string' && payload.jti ? payload.jti : null };
  }

  /** The URL that sends the browser to the IdP. */
  async authorizationUrl(provider: IdentityProvider, checks: OidcChecks): Promise<URL> {
    const config = await this.configuration(provider);
    const preset = OIDC_PRESETS[presetOf(provider.preset)];
    const { scopes } = oidcConfigOf(provider);
    const scope = preset.oauth2
      ? (scopes.length ? scopes : preset.scopes).join(' ')
      : ['openid', ...(scopes.length ? scopes : preset.scopes).filter((s) => s !== 'openid')].join(' ');
    return client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(provider.id),
      scope,
      state: checks.state,
      code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
      code_challenge_method: 'S256',
      ...(checks.nonce ? { nonce: checks.nonce } : {}),
    });
  }

  /**
   * Redeem the code the IdP sent back. Throws on anything the library rejects
   * (a bad signature, a wrong nonce, an IdP error); the caller turns that into
   * a failed sign-in with the message kept for the audit row only.
   */
  async complete(provider: IdentityProvider, callback: URL, checks: OidcChecks): Promise<ClaimsResult> {
    const config = await this.configuration(provider);
    const preset = presetOf(provider.preset);
    const groupsClaim = provider.groupsClaim ?? OIDC_PRESETS[preset].groupsClaim;
    const yandex = OIDC_PRESETS[preset].oauth2;

    const tokens = await client.authorizationCodeGrant(
      config,
      callback,
      yandex
        ? { pkceCodeVerifier: checks.codeVerifier, expectedState: checks.state, idTokenExpected: false }
        : {
            pkceCodeVerifier: checks.codeVerifier,
            expectedState: checks.state,
            expectedNonce: checks.nonce ?? undefined,
            idTokenExpected: true,
          },
    );

    if (yandex) {
      const res = await safeFetch(
        yandex.userinfoEndpoint,
        { headers: { Authorization: `OAuth ${tokens.access_token}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_SEC * 1000) },
        this.allowPrivate,
      );
      if (!res.ok) throw new Error(`userinfo answered ${res.status}`);
      return identityFromYandex((await res.json()) as Record<string, unknown>);
    }

    let claims: Record<string, unknown> = { ...tokens.claims() };
    // An id_token may leave the address out (Keycloak without the email scope
    // mapper, Entra without the optional claim); userinfo is asked only then.
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    if (!claims.email && sub && config.serverMetadata().userinfo_endpoint) {
      const info = await client.fetchUserInfo(config, tokens.access_token, sub);
      claims = { ...info, ...claims, email: info.email, email_verified: info.email_verified };
    }
    return identityFromClaims(preset, claims, { issuer: config.serverMetadata().issuer, groupsClaim });
  }

  /** "Test connection": can the discovery document be read, and what does it name. */
  async test(provider: IdentityProvider): Promise<TestIdentityProviderResponse> {
    try {
      this.cache.delete(provider.id);
      const meta = (await this.configuration(provider)).serverMetadata();
      return { ok: true, issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint ?? null, error: null };
    } catch (e) {
      return { ok: false, issuer: null, authorizationEndpoint: null, error: (e as Error).message.slice(0, 500) };
    }
  }

  forget(providerId: string): void {
    this.cache.delete(providerId);
    this.jwks.delete(providerId);
  }

  private async configuration(provider: IdentityProvider): Promise<client.Configuration> {
    // updatedAt is the cache key's second half: an edit is a new configuration.
    const stamp = provider.updatedAt.toISOString();
    const hit = this.cache.get(provider.id);
    if (hit && hit.stamp === stamp && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.config;

    const preset = OIDC_PRESETS[presetOf(provider.preset)];
    const { issuer: typed, clientId } = oidcConfigOf(provider);
    const issuer = preset.issuer ?? typed;
    const secret = decryptSecret(provider.secretCipher, this.key) ?? undefined;
    const auth = secret ? client.ClientSecretPost(secret) : client.None();
    const fetchVia: client.CustomFetch = (url, options) =>
      safeFetch(url, options as unknown as RequestInit, this.allowPrivate);
    // Plain http only where private addresses are allowed: a Keycloak on the LAN.
    const insecure = this.allowPrivate && issuer.startsWith('http:');

    let config: client.Configuration;
    if (preset.oauth2) {
      config = new client.Configuration(
        {
          issuer,
          authorization_endpoint: preset.oauth2.authorizationEndpoint,
          token_endpoint: preset.oauth2.tokenEndpoint,
        },
        clientId,
        undefined,
        auth,
      );
      config[client.customFetch] = fetchVia;
      config.timeout = HTTP_TIMEOUT_SEC;
    } else {
      config = await client.discovery(new URL(issuer), clientId, undefined, auth, {
        [client.customFetch]: fetchVia,
        timeout: HTTP_TIMEOUT_SEC,
        ...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
      });
    }
    this.cache.set(provider.id, { stamp, at: Date.now(), config });
    return config;
  }
}
