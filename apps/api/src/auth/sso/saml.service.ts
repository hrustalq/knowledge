import { X509Certificate } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityProvider } from '@prisma/client';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type { TestIdentityProviderResponse } from '@knowledge/contracts';
import { decryptSecret, parseKey } from '../../ai/secret-box.js';
import type { Env } from '../../config/env.js';
import { parseCertificates } from './saml-cert.js';
import { samlConfigOf } from './saml-profile.js';

/** The plan's ceiling (#75): an IdP clock may be this far off ours, no further. */
const CLOCK_SKEW_MS = 60_000;

/** The AuthnRequest a response must answer, as `sso_auth_requests` remembers it. */
export interface SamlExpected {
  requestId: string;
  issuedAt: Date;
}

export interface SamlAssertion {
  profile: Profile;
  /** The assertion's own `ID`, which the caller spends so it cannot be posted twice. */
  assertionId: string;
}

/**
 * SAML 2.0 for one provider row (#75 phase 6), on `@node-saml/node-saml`.
 *
 * - **Signed.** A response is accepted when the Response or the Assertion is
 *   signed by a pinned IdP certificate (Keycloak signs the first by default,
 *   Entra the second). node-saml reads the assertion only out of the signed
 *   bytes, which is what defeats signature wrapping. Both `want*Signed` flags
 *   are off because each demands its own element be signed; with both off the
 *   library still refuses a response where neither is.
 * - **Answers our request.** `InResponseTo` must name the AuthnRequest the
 *   login transaction recorded, checked through a cache provider that knows
 *   exactly that one id. An IdP-initiated response (no `InResponseTo`) is
 *   accepted only where `allowIdpInitiated` says so.
 * - **For us.** The audience is our entity ID, the issuer the configured one.
 * - **Fresh.** At most `AUTH_SSO_STATE_TTL_SEC` old, with 60 s of skew. That
 *   bound is what lets the caller's assertion-ID replay marker expire.
 *
 * Nothing here makes a network request: the SSO URL is where the browser goes.
 */
@Injectable()
export class SamlService {
  private readonly key: Buffer | null;
  private readonly apiBase: string;
  private readonly maxAgeMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.apiBase = config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    this.maxAgeMs = config.get('AUTH_SSO_STATE_TTL_SEC', { infer: true }) * 1000;
  }

  /** Our entity ID — and the URL the metadata is served at, so an IdP can import it by URL. */
  entityId(providerId: string): string {
    return `${this.apiBase}/v1/auth/saml/${providerId}/metadata`;
  }

  acsUrl(providerId: string): string {
    return `${this.apiBase}/v1/auth/saml/${providerId}/acs`;
  }

  /** How long a replay marker must outlive the moment an assertion was accepted. */
  get assertionLifetimeMs(): number {
    return this.maxAgeMs + CLOCK_SKEW_MS;
  }

  /** The redirect to the IdP, and the AuthnRequest id the response must answer. */
  async authorizationUrl(provider: IdentityProvider, relayState: string): Promise<{ url: string; requestId: string }> {
    let requestId: string | null = null;
    const saml = this.instance(provider, ValidateInResponseTo.always, {
      // node-saml stores each request id it issues here; this one is kept by the caller instead.
      saveAsync: async (key, value) => {
        requestId = key;
        return { value, createdAt: Date.now() };
      },
      getAsync: async () => null,
      removeAsync: async () => null,
    });
    const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
    if (!requestId) throw new Error('no AuthnRequest id was issued');
    return { url, requestId };
  }

  /**
   * Validate a posted `SAMLResponse`. Throws on anything the library or the
   * issuer check rejects; the caller keeps the message for the audit row only.
   */
  async validate(provider: IdentityProvider, samlResponse: string, expected: SamlExpected | null): Promise<SamlAssertion> {
    // Only the one request this transaction issued is known; anything else reads as "not ours".
    const known: CacheProvider = {
      saveAsync: async () => null,
      getAsync: async (key) => (expected && key === expected.requestId ? expected.issuedAt.toISOString() : null),
      removeAsync: async () => null,
    };
    // Unsolicited: no request to answer, and a response claiming to answer one is refused (ifPresent + empty cache).
    const saml = this.instance(provider, expected ? ValidateInResponseTo.always : ValidateInResponseTo.ifPresent, known);
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
    if (!profile) throw new Error('response carries no assertion');

    const { idpEntityId } = samlConfigOf(provider);
    if (profile.issuer !== idpEntityId) throw new Error(`issuer ${String(profile.issuer)} is not ${idpEntityId}`);
    const assertion = profile.getAssertion?.() as { Assertion?: { $?: { ID?: unknown } } } | undefined;
    const assertionId = assertion?.Assertion?.$?.ID;
    if (typeof assertionId !== 'string' || !assertionId) throw new Error('assertion has no ID');
    return { profile, assertionId };
  }

  /** The SP metadata an admin uploads to (or points) the IdP at. */
  metadata(provider: IdentityProvider): string {
    const { spCert } = samlConfigOf(provider);
    return this.instance(provider, ValidateInResponseTo.never).generateServiceProviderMetadata(spCert, spCert);
  }

  /** "Test": the pinned certificates parse and are in date, and the SP key can be read. No IdP is contacted. */
  test(provider: IdentityProvider): TestIdentityProviderResponse {
    const { idpEntityId, ssoUrl, idpCert } = samlConfigOf(provider);
    const certs = parseCertificates(idpCert);
    const now = new Date();
    const error = !certs
      ? 'IdP certificate does not parse'
      : !certs.some((c) => new Date(new X509Certificate(c).validTo) > now)
        ? 'every IdP certificate has expired'
        : !decryptSecret(provider.secretCipher, this.key)
          ? 'the SP key cannot be decrypted (SETTINGS_ENCRYPTION_KEY changed or unset)'
          : null;
    return { ok: error === null, issuer: idpEntityId || null, authorizationEndpoint: ssoUrl || null, error };
  }

  private instance(provider: IdentityProvider, validateInResponseTo: ValidateInResponseTo, cacheProvider?: CacheProvider): SAML {
    const cfg = samlConfigOf(provider);
    const spKey = decryptSecret(provider.secretCipher, this.key);
    if (!spKey) throw new Error('the SP key cannot be decrypted (SETTINGS_ENCRYPTION_KEY changed or unset)');
    const entityId = this.entityId(provider.id);
    return new SAML({
      callbackUrl: this.acsUrl(provider.id),
      issuer: entityId,
      audience: entityId,
      entryPoint: cfg.ssoUrl,
      idpCert: parseCertificates(cfg.idpCert) ?? [],
      privateKey: spKey,
      decryptionPvk: spKey,
      publicCert: cfg.spCert,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      wantAssertionsSigned: false,
      wantAuthnResponseSigned: false,
      // The IdP's configured NameID format wins; a transient one is refused later.
      identifierFormat: null,
      // A fixed PasswordProtectedTransport context fails Entra/ADFS sign-ins done with MFA or Kerberos.
      disableRequestedAuthnContext: true,
      acceptedClockSkewMs: CLOCK_SKEW_MS,
      maxAssertionAgeMs: this.maxAgeMs,
      requestIdExpirationPeriodMs: this.maxAgeMs,
      validateInResponseTo,
      ...(cacheProvider ? { cacheProvider } : {}),
    });
  }
}
