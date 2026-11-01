import { domainToASCII } from 'node:url';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityProvider, Prisma } from '@prisma/client';
import {
  GROUP_SYNC_MODES,
  IDP_KINDS,
  WORKSPACE_ROLES,
  type GroupSyncMode,
  type IdentityProviderView,
  type IdpKind,
  type ListIdentityProvidersResponse,
  type SamlProviderView,
  type TestIdentityProviderResponse,
  type WorkspaceRole,
} from '@knowledge/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { encryptSecret, MissingEncryptionKeyError, parseKey } from '../../ai/secret-box.js';
import { assertSafeExternalUrl } from '../../common/safe-url.js';
import type { Env } from '../../config/env.js';
import { t } from '../../i18n/t.js';
import { AuditService } from '../audit.service.js';
import type { Principal } from '../principal.js';
import type { CreateIdentityProviderDto, UpdateIdentityProviderDto } from './identity-providers.dto.js';
import { OIDC_PRESETS, presetOf } from './oidc-presets.js';
import { oidcConfigOf, OidcService } from './oidc.service.js';
import { liveIdpKinds } from './live-kinds.js';
import { ldapConfigOf, ldapUrlProblem, userFilterValid } from './ldap-profile.js';
import { LdapService } from './ldap.service.js';
import { generateSpKeyPair, parseCertificates } from './saml-cert.js';
import { samlConfigOf } from './saml-profile.js';
import { SamlService } from './saml.service.js';
import { AuthPolicyService } from '../auth-policy.service.js';

const ISSUER_KEYS = {
  invalid: 'error.sso.issuerInvalid',
  notHttps: 'error.sso.issuerNotHttps',
  unresolved: 'error.sso.issuerUnresolved',
  private: 'error.sso.issuerPrivate',
};
/** The directory host is checked as an https origin: the scheme was judged already, the address is what is left. */
const LDAP_HOST_KEYS = {
  invalid: 'error.sso.ldapUrlInvalid',
  notHttps: 'error.sso.ldapUrlInvalid',
  unresolved: 'error.sso.ldapHostUnresolved',
  private: 'error.sso.ldapHostPrivate',
};

/** The editable fields an audit row may name — never a value, and never the secret's. */
const AUDITED_FIELDS = [
  'name', 'preset', 'enabled', 'showOnLogin', 'platformWide', 'issuer', 'clientId', 'scopes', 'jitEnabled',
  'defaultRole', 'allowedDomains', 'groupsClaim', 'groupSyncMode', 'sessionTtlHours',
  'idpEntityId', 'ssoUrl', 'idpCert', 'allowIdpInitiated', 'emailAttribute', 'nameAttribute',
  'ldapUrl', 'startTls', 'bindDn', 'baseDn', 'userFilter',
] as const;
/** Write-only fields: an audit row says they changed, never to what. */
const SECRET_FIELDS = ['clientSecret', 'bindPassword'] as const;

/** `corp.example`, `@Corp.Example`, `bücher.example` → one lower-case punycode form, or null when it is no domain. */
export function normalizeDomain(raw: string): string | null {
  const ascii = domainToASCII(raw.trim().replace(/^@/, '').replace(/\.$/, '').toLowerCase());
  return ascii && /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(ascii) ? ascii : null;
}

/**
 * A workspace's identity providers (#75). The client secret goes through
 * secret-box and never comes back out — the view says `hasSecret` only. A
 * SAML provider's SP private key is generated here on create, into the same
 * column, and never leaves the API either; its certificate is public. An LDAP
 * provider's service-account password is that column's third use.
 * Child ids are always re-checked against the route's workspace, so another
 * workspace's provider id is a 404 here, not a 403 that confirms it exists.
 */
@Injectable()
export class IdentityProvidersService {
  private readonly key: Buffer | null;
  private readonly allowPrivate: boolean;
  private readonly allowInsecureLdap: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly oidc: OidcService,
    private readonly audit: AuditService,
    private readonly policy: AuthPolicyService,
    private readonly saml: SamlService,
    private readonly ldap: LdapService,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivate = config.get('AUTH_SSO_ALLOW_PRIVATE_URLS', { infer: true });
    this.allowInsecureLdap = config.get('AUTH_LDAP_ALLOW_INSECURE', { infer: true });
  }

  async list(workspaceId: string): Promise<ListIdentityProvidersResponse> {
    const rows = await this.prisma.identityProvider.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { providers: rows.map((r) => this.view(r)), secretsWritable: this.key !== null, kinds: liveIdpKinds(this.config) };
  }

  async create(workspaceId: string, dto: CreateIdentityProviderDto, principal: Principal): Promise<IdentityProviderView> {
    if (!liveIdpKinds(this.config).includes(dto.kind)) throw new BadRequestException(t('error.sso.kindNotSupported', { kind: dto.kind }));
    const fields = await this.fields(dto.kind, dto, principal, null);
    const row = await this.prisma.identityProvider.create({
      data: { workspaceId, kind: dto.kind, name: dto.name.trim(), ...fields, ...(dto.kind === 'saml' ? this.spKeyPair(fields) : {}) },
    });
    void this.audit.record({ ...this.entry(principal, row, changedFields(dto)), action: 'sso.provider_created' });
    // Which providers satisfy enforced SSO may have changed — here and, for a platform-wide one, everywhere.
    this.policy.invalidate();
    return this.view(row);
  }

  async update(
    workspaceId: string,
    providerId: string,
    dto: UpdateIdentityProviderDto,
    principal: Principal,
  ): Promise<IdentityProviderView> {
    const existing = await this.owned(workspaceId, providerId);
    const fields = await this.fields(existing.kind as IdpKind, dto, principal, existing);
    const row = await this.prisma.identityProvider.update({
      where: { id: existing.id },
      data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), ...fields },
    });
    this.oidc.forget(row.id);
    void this.audit.record({ ...this.entry(principal, row, changedFields(dto)), action: 'sso.provider_updated' });
    this.policy.invalidate();
    return this.view(row);
  }

  /** Deleting a provider also ends the sessions it vouched for: nothing stands behind them any more. */
  async remove(workspaceId: string, providerId: string, principal: Principal): Promise<void> {
    const existing = await this.owned(workspaceId, providerId);
    // One commit (#656): a retry 404s in owned(), so a delete that outlived a failed revoke would leave the sessions live for good.
    await this.prisma.withTransaction(async () => {
      const { count } = await this.prisma.session.updateMany({
        where: { providerId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.prisma.identityProvider.delete({ where: { id: existing.id } });
      this.prisma.onCommit(async () => {
        this.oidc.forget(existing.id);
        await this.audit.record({ ...this.entry(principal, existing, [], { sessionsRevoked: count }), action: 'sso.provider_deleted' });
      });
    });
    this.policy.invalidate();
  }

  async test(workspaceId: string, providerId: string): Promise<TestIdentityProviderResponse> {
    const provider = await this.owned(workspaceId, providerId);
    if (provider.kind === 'saml') return this.saml.test(provider);
    return provider.kind === 'ldap' ? this.ldap.test(provider) : this.oidc.test(provider);
  }

  private async owned(workspaceId: string, providerId: string): Promise<IdentityProvider> {
    const row = await this.prisma.identityProvider.findFirst({ where: { id: providerId, workspaceId } });
    if (!row) throw new NotFoundException(t('error.sso.providerNotFound'));
    return row;
  }

  /** Validate and translate a create/update body into columns. `existing` is null on create. */
  private async fields(
    kind: IdpKind,
    dto: UpdateIdentityProviderDto,
    principal: Principal,
    existing: IdentityProvider | null,
  ): Promise<ProviderColumns> {
    // Platform-wide reaches every workspace's login page: only someone who may act on all of them sets it.
    if (dto.platformWide !== undefined && dto.platformWide !== (existing?.platformWide ?? false) && !principal.isAdmin) {
      throw new ForbiddenException(t('error.sso.platformWideAdminOnly'));
    }

    let allowedDomains: string[] | undefined;
    if (dto.allowedDomains) {
      allowedDomains = [];
      for (const raw of dto.allowedDomains) {
        const domain = normalizeDomain(raw);
        if (!domain) throw new BadRequestException(t('error.sso.invalidDomain', { domain: raw.slice(0, 100) }));
        if (!allowedDomains.includes(domain)) allowedDomains.push(domain);
      }
    }

    return {
      ...(kind === 'saml'
        ? this.samlFields(dto, existing)
        : kind === 'ldap'
          ? await this.ldapFields(dto, existing)
          : await this.oidcFields(dto, existing)),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.showOnLogin !== undefined ? { showOnLogin: dto.showOnLogin } : {}),
      ...(dto.platformWide !== undefined ? { platformWide: dto.platformWide } : {}),
      ...(dto.jitEnabled !== undefined ? { jitEnabled: dto.jitEnabled } : {}),
      ...(dto.defaultRole !== undefined ? { defaultRole: dto.defaultRole } : {}),
      ...(allowedDomains ? { allowedDomains } : {}),
      ...(dto.groupsClaim !== undefined ? { groupsClaim: dto.groupsClaim?.trim() || null } : {}),
      ...(dto.groupSyncMode !== undefined ? { groupSyncMode: dto.groupSyncMode } : {}),
      ...(dto.sessionTtlHours !== undefined ? { sessionTtlHours: dto.sessionTtlHours } : {}),
    };
  }

  private async oidcFields(dto: UpdateIdentityProviderDto, existing: IdentityProvider | null): Promise<ProviderColumns> {
    const preset = presetOf(dto.preset ?? existing?.preset ?? 'generic');
    const current = existing ? oidcConfigOf(existing) : { issuer: '', clientId: '', scopes: [] };
    const issuer = (dto.issuer ?? current.issuer).trim().replace(/\/+$/, '');
    const clientId = (dto.clientId ?? current.clientId).trim();
    const scopes = dto.scopes ? dto.scopes.map((s) => s.trim()).filter(Boolean) : current.scopes;

    // The google and yandex presets are one IdP each; their issuer is not the admin's to type.
    if (!OIDC_PRESETS[preset].issuer) {
      if (!issuer) throw new BadRequestException(t('error.sso.issuerRequired'));
      await assertSafeExternalUrl(issuer, this.allowPrivate, ISSUER_KEYS);
    }
    if (!clientId) throw new BadRequestException(t('error.sso.clientIdRequired'));

    return {
      preset,
      config: { issuer: OIDC_PRESETS[preset].issuer ?? issuer, clientId, scopes },
      ...this.secret(dto.clientSecret),
    };
  }

  /** A write-only secret: a value is stored encrypted, `''` clears it, absent keeps it. */
  private secret(value: string | undefined): Pick<ProviderColumns, 'secretCipher'> {
    if (value === undefined) return {};
    if (value === '') return { secretCipher: null };
    try {
      return { secretCipher: encryptSecret(value, this.key) };
    } catch (e) {
      if (e instanceof MissingEncryptionKeyError) throw new BadRequestException(t('error.sso.secretKeyMissing'));
      throw e;
    }
  }

  /**
   * The LDAP half. The URL must be `ldaps://`, or `ldap://` with StartTLS,
   * unless AUTH_LDAP_ALLOW_INSECURE says this is a lab — checked here so an
   * admin reads why in the form, and again on every sign-in, so turning the
   * flag off stops a clear-text provider at once. The service-account
   * password is `bindPassword`; a stray `clientSecret` is ignored.
   */
  private async ldapFields(dto: UpdateIdentityProviderDto, existing: IdentityProvider | null): Promise<ProviderColumns> {
    const current = ldapConfigOf(existing ?? { config: {} });
    const url = (dto.ldapUrl ?? current.url).trim().replace(/\/+$/, '');
    const secure = url.toLowerCase().startsWith('ldaps:');
    const startTls = !secure && (dto.startTls ?? current.startTls);
    const problem = ldapUrlProblem({ url, startTls }, this.allowInsecureLdap);
    if (problem) throw new BadRequestException(t(problem === 'insecure' ? 'error.sso.ldapInsecure' : 'error.sso.ldapUrlInvalid'));
    await assertSafeExternalUrl(`https://${new URL(url).host}`, this.allowPrivate, LDAP_HOST_KEYS);

    const optional = (sent: string | null | undefined, kept: string | null) => (sent === undefined ? kept : sent?.trim() || null);
    const baseDn = (dto.baseDn ?? current.baseDn).trim();
    if (!baseDn) throw new BadRequestException(t('error.sso.baseDnRequired'));
    const userFilter = optional(dto.userFilter, current.userFilter);
    if (userFilter && !userFilterValid(userFilter)) throw new BadRequestException(t('error.sso.userFilterInvalid', { username: '{username}' }));

    return {
      preset: 'generic',
      config: {
        url,
        startTls,
        bindDn: optional(dto.bindDn, current.bindDn),
        baseDn,
        userFilter,
        emailAttribute: optional(dto.emailAttribute, current.emailAttribute),
        nameAttribute: optional(dto.nameAttribute, current.nameAttribute),
      },
      ...this.secret(dto.bindPassword),
    };
  }

  /**
   * The SAML half. The SP certificate is carried over from the stored config
   * (an admin never sends it), and the OIDC client secret is ignored: the
   * column holds the SP key here, and a stray `clientSecret` must not
   * overwrite it.
   */
  private samlFields(dto: UpdateIdentityProviderDto, existing: IdentityProvider | null): ProviderColumns {
    const current = samlConfigOf(existing ?? { config: {} });
    const idpEntityId = (dto.idpEntityId ?? current.idpEntityId).trim();
    const ssoUrl = (dto.ssoUrl ?? current.ssoUrl).trim();
    const idpCert = (dto.idpCert ?? current.idpCert).trim();
    const attribute = (sent: string | null | undefined, kept: string | null) => (sent === undefined ? kept : sent?.trim() || null);

    if (!idpEntityId) throw new BadRequestException(t('error.sso.idpEntityIdRequired'));
    let url: URL | null = null;
    try {
      url = new URL(ssoUrl);
    } catch {
      // reported below
    }
    // Only the browser goes there, so no DNS check — but never plain http to an IdP on the internet.
    if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && this.allowPrivate))) {
      throw new BadRequestException(t('error.sso.ssoUrlInvalid'));
    }
    const certs = parseCertificates(idpCert);
    if (!certs) throw new BadRequestException(t('error.sso.idpCertInvalid'));

    return {
      preset: 'generic',
      config: {
        idpEntityId,
        ssoUrl: url.href,
        idpCert: certs.join('\n'),
        allowIdpInitiated: dto.allowIdpInitiated ?? current.allowIdpInitiated,
        emailAttribute: attribute(dto.emailAttribute, current.emailAttribute),
        nameAttribute: attribute(dto.nameAttribute, current.nameAttribute),
        spCert: current.spCert,
      },
    };
  }

  /** A new SAML provider's SP key pair: the key into secret-box, the certificate beside the settings. */
  // ponytail: made once on create, no rotation route; add one when an IdP asks for an SP cert rollover or SETTINGS_ENCRYPTION_KEY is rotated.
  private spKeyPair(fields: ProviderColumns): Pick<ProviderColumns, 'config' | 'secretCipher'> {
    const pair = generateSpKeyPair('Knowledge SAML SP');
    let secretCipher: string;
    try {
      secretCipher = encryptSecret(pair.privateKeyPem, this.key);
    } catch (e) {
      if (e instanceof MissingEncryptionKeyError) throw new BadRequestException(t('error.sso.secretKeyMissing'));
      throw e;
    }
    return { config: { ...(fields.config as Record<string, unknown>), spCert: pair.certPem.trim() }, secretCipher };
  }

  /** An audit row about a provider, less its action — which each call site spells out. */
  private entry(principal: Principal, provider: IdentityProvider, fields: string[], extra: Record<string, unknown> = {}) {
    return {
      workspaceId: provider.workspaceId,
      actor: principal.userId,
      params: { providerId: provider.id, name: provider.name, kind: provider.kind, fields, ...extra },
      ok: true,
      target: provider.id,
    };
  }

  view(r: IdentityProvider): IdentityProviderView {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      kind: (IDP_KINDS as readonly string[]).includes(r.kind) ? (r.kind as IdpKind) : 'oidc',
      preset: presetOf(r.preset),
      name: r.name,
      enabled: r.enabled,
      showOnLogin: r.showOnLogin,
      platformWide: r.platformWide,
      config: oidcConfigOf(r),
      saml: r.kind === 'saml' ? this.samlView(r) : null,
      ldap: r.kind === 'ldap' ? ldapConfigOf(r) : null,
      hasSecret: r.secretCipher !== null,
      jitEnabled: r.jitEnabled,
      defaultRole: (WORKSPACE_ROLES as readonly string[]).includes(r.defaultRole ?? '') ? (r.defaultRole as WorkspaceRole) : null,
      allowedDomains: r.allowedDomains,
      groupsClaim: r.groupsClaim,
      groupSyncMode: (GROUP_SYNC_MODES as readonly string[]).includes(r.groupSyncMode) ? (r.groupSyncMode as GroupSyncMode) : 'additive',
      sessionTtlHours: r.sessionTtlHours,
      redirectUri: r.kind === 'saml' ? this.saml.acsUrl(r.id) : r.kind === 'ldap' ? '' : this.oidc.redirectUri(r.id),
      backchannelLogoutUri: r.kind === 'oidc' ? this.oidc.backchannelLogoutUri(r) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private samlView(r: IdentityProvider): SamlProviderView {
    const { spCert: _cert, ...settings } = samlConfigOf(r);
    return { ...settings, entityId: this.saml.entityId(r.id) };
  }
}

type ProviderColumns = Omit<Prisma.IdentityProviderUncheckedCreateInput, 'workspaceId' | 'kind' | 'name'>;


/** Which fields a body set, by name — a secret only as "the secret changed", never its value. */
function changedFields(dto: UpdateIdentityProviderDto): string[] {
  return [...AUDITED_FIELDS, ...SECRET_FIELDS].filter((f) => (dto as Record<string, unknown>)[f] !== undefined);
}
