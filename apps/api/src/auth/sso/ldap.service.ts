import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityProvider } from '@prisma/client';
import { Client, ResultCodeError, SizeLimitExceededError, type Entry } from 'ldapts';
import type { TestIdentityProviderResponse } from '@knowledge/contracts';
import { decryptSecret, parseKey } from '../../ai/secret-box.js';
import { guardedLookup } from '../../common/safe-fetch.js';
import type { Env } from '../../config/env.js';
import { ldapConfigOf, ldapUrlProblem, userFilterFor } from './ldap-profile.js';

/** A directory that does not answer fails the sign-in, it does not hang it. */
const TIMEOUT_MS = 10_000;
/** The attribute an LDAP provider reads groups from when `groupsClaim` names none. */
export const LDAP_DEFAULT_GROUPS_ATTRIBUTE = 'memberOf';

/**
 * Why a sign-in failed, for the audit row. The person gets one answer for the
 * first four — no entry, two entries, a wrong password and an empty one are
 * indistinguishable from outside — and a different one only when the directory
 * itself could not be reached, which says nothing about any account.
 */
export type LdapFailure = 'empty-password' | 'no-entry' | 'ambiguous' | 'wrong-password' | 'unavailable';

export type LdapAuthResult = { ok: true; entry: Entry } | { ok: false; failure: LdapFailure; detail: string };

/**
 * LDAP / Active Directory bind sign-in (#75 phase 7): bind as the service
 * account, find the one entry the typed username names, then bind as that
 * entry with the typed password. The attributes are read by the service
 * account's search, so a person who may not read their own entry still signs in.
 *
 * Every socket resolves its host through `guardedLookup` unless
 * AUTH_SSO_ALLOW_PRIVATE_URLS says the directory is on-prem — which an LDAP
 * server almost always is, so that flag is usually on where this is used.
 */
@Injectable()
export class LdapService {
  private readonly key: Buffer | null;
  private readonly allowPrivate: boolean;
  private readonly allowInsecure: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivate = config.get('AUTH_SSO_ALLOW_PRIVATE_URLS', { infer: true });
    this.allowInsecure = config.get('AUTH_LDAP_ALLOW_INSECURE', { infer: true });
  }

  async authenticate(provider: IdentityProvider, username: string, password: string): Promise<LdapAuthResult> {
    // An empty password is an *unauthenticated* bind (RFC 4513 §5.1.2), which
    // many servers answer with success. Refused before any socket opens.
    if (!password) return { ok: false, failure: 'empty-password', detail: 'empty password' };
    const login = username.trim();
    if (!login) return { ok: false, failure: 'no-entry', detail: 'empty username' };

    const config = ldapConfigOf(provider);
    const groupsAttribute = provider.groupsClaim ?? LDAP_DEFAULT_GROUPS_ATTRIBUTE;
    return this.session(provider, async (client) => {
      let entries: Entry[];
      try {
        ({ searchEntries: entries } = await client.search(config.baseDn, {
          scope: 'sub',
          filter: userFilterFor(config.userFilter, login),
          sizeLimit: 2,
          // The identity's attributes plus both kinds of immutable id (OpenLDAP, AD).
          attributes: ['entryUUID', 'objectGUID', config.emailAttribute ?? 'mail', ...(config.nameAttribute ? [config.nameAttribute] : ['displayName', 'cn']), groupsAttribute],
          explicitBufferAttributes: ['objectGUID'],
        }));
      } catch (e) {
        if (e instanceof SizeLimitExceededError) return { ok: false, failure: 'ambiguous', detail: 'more than one entry matches' };
        throw e;
      }
      if (entries.length !== 1) {
        return { ok: false, failure: entries.length ? 'ambiguous' : 'no-entry', detail: `${entries.length} entries match` };
      }
      try {
        await client.bind(entries[0].dn, password);
      } catch (e) {
        // Wrong password, locked, expired: the directory's answer for this
        // entry, never the directory being down. AD tells them apart only in
        // a diagnostic string, which goes to the audit row.
        if (e instanceof ResultCodeError) return { ok: false, failure: 'wrong-password', detail: (e as Error).message.slice(0, 300) };
        throw e;
      }
      return { ok: true, entry: entries[0] };
    });
  }

  /** "Test connection": the service account binds and can read the base DN. */
  async test(provider: IdentityProvider): Promise<TestIdentityProviderResponse> {
    const config = ldapConfigOf(provider);
    const result = await this.session(provider, async (client) => {
      await client.search(config.baseDn, { scope: 'base', sizeLimit: 1, attributes: ['1.1'] });
      return { ok: true, entry: { dn: config.baseDn } } as const;
    });
    return { ok: result.ok, issuer: config.url, authorizationEndpoint: null, error: result.ok ? null : result.detail };
  }

  /** Connect, StartTLS, bind as the service account, run `body`, always unbind. A failure before `body` is `unavailable`. */
  private async session(provider: IdentityProvider, body: (client: Client) => Promise<LdapAuthResult>): Promise<LdapAuthResult> {
    const config = ldapConfigOf(provider);
    const problem = ldapUrlProblem(config, this.allowInsecure);
    if (problem) return { ok: false, failure: 'unavailable', detail: `directory url ${problem}` };

    const url = new URL(config.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const client = this.client(config.url, host, url.protocol === 'ldaps:');
    try {
      if (url.protocol === 'ldap:' && config.startTls) await client.startTLS(this.tlsOptions(host));
      if (config.bindDn) await client.bind(config.bindDn, decryptSecret(provider.secretCipher, this.key) ?? '');
      return await body(client);
    } catch (e) {
      return { ok: false, failure: 'unavailable', detail: (e as Error).message.slice(0, 300) };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  // ponytail: system CAs (+ NODE_EXTRA_CA_CERTS) only; add a per-provider CA field when an AD with a private CA cannot set that env.
  private tlsOptions(host: string): ConnectionOptions {
    return { minVersion: 'TLSv1.2', ...(isIP(host) ? {} : { servername: host }) };
  }

  private client(url: string, host: string, ldaps: boolean): Client {
    const lookup = this.allowPrivate ? {} : { lookup: guardedLookup };
    const tlsOptions = this.tlsOptions(host);
    return new Client({
      url,
      timeout: TIMEOUT_MS,
      connectTimeout: TIMEOUT_MS,
      // ldapts takes *any* tlsOptions as "TLS from the first byte", even on ldap://, which would
      // break plain and StartTLS connections alike. StartTLS gets its options at the upgrade.
      ...(ldaps ? { tlsOptions } : {}),
      createConnection: ((port: number, h: string) => netConnect({ port, host: h, ...lookup })) as typeof netConnect,
      // ldaps:// dials with (port, host, tlsOptions); StartTLS upgrades with (options) holding the open socket.
      createSecureConnection: ((...args: unknown[]) =>
        typeof args[0] === 'number'
          ? tlsConnect({ port: args[0], host: args[1] as string, ...tlsOptions, ...lookup })
          : tlsConnect(args[0] as ConnectionOptions)) as typeof tlsConnect,
    });
  }
}
