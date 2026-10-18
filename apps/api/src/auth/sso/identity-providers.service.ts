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
import { LIVE_IDP_KINDS } from './live-kinds.js';
import { AuthPolicyService } from '../auth-policy.service.js';

const ISSUER_KEYS = {
  invalid: 'error.sso.issuerInvalid',
  notHttps: 'error.sso.issuerNotHttps',
  unresolved: 'error.sso.issuerUnresolved',
  private: 'error.sso.issuerPrivate',
};

/** The editable fields an audit row may name — never a value, and never the secret's. */
const AUDITED_FIELDS = [
  'name', 'preset', 'enabled', 'showOnLogin', 'platformWide', 'issuer', 'clientId', 'scopes', 'jitEnabled',
  'defaultRole', 'allowedDomains', 'groupsClaim', 'groupSyncMode', 'sessionTtlHours',
] as const;

/** `corp.example`, `@Corp.Example`, `bücher.example` → one lower-case punycode form, or null when it is no domain. */
export function normalizeDomain(raw: string): string | null {
  const ascii = domainToASCII(raw.trim().replace(/^@/, '').replace(/\.$/, '').toLowerCase());
  return ascii && /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(ascii) ? ascii : null;
}

/**
 * A workspace's identity providers (#75). The client secret goes through
 * secret-box and never comes back out — the view says `hasSecret` only.
 * Child ids are always re-checked against the route's workspace, so another
 * workspace's provider id is a 404 here, not a 403 that confirms it exists.
 */
@Injectable()
export class IdentityProvidersService {
  private readonly key: Buffer | null;
  private readonly allowPrivate: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly oidc: OidcService,
    private readonly audit: AuditService,
    private readonly policy: AuthPolicyService,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivate = config.get('AUTH_SSO_ALLOW_PRIVATE_URLS', { infer: true });
  }

  async list(workspaceId: string): Promise<ListIdentityProvidersResponse> {
    const rows = await this.prisma.identityProvider.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { providers: rows.map((r) => this.view(r)), secretsWritable: this.key !== null };
  }

  async create(workspaceId: string, dto: CreateIdentityProviderDto, principal: Principal): Promise<IdentityProviderView> {
    if (!LIVE_IDP_KINDS.includes(dto.kind)) throw new BadRequestException(t('error.sso.kindNotSupported', { kind: dto.kind }));
    const fields = await this.fields(dto, principal, null);
    const row = await this.prisma.identityProvider.create({
      data: { workspaceId, kind: dto.kind, name: dto.name.trim(), ...fields },
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
    const fields = await this.fields(dto, principal, existing);
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
    await this.prisma.identityProvider.delete({ where: { id: existing.id } });
    const { count } = await this.prisma.session.updateMany({
      where: { providerId: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.oidc.forget(existing.id);
    void this.audit.record({ ...this.entry(principal, existing, [], { sessionsRevoked: count }), action: 'sso.provider_deleted' });
    this.policy.invalidate();
  }

  async test(workspaceId: string, providerId: string): Promise<TestIdentityProviderResponse> {
    return this.oidc.test(await this.owned(workspaceId, providerId));
  }

  private async owned(workspaceId: string, providerId: string): Promise<IdentityProvider> {
    const row = await this.prisma.identityProvider.findFirst({ where: { id: providerId, workspaceId } });
    if (!row) throw new NotFoundException(t('error.sso.providerNotFound'));
    return row;
  }

  /** Validate and translate a create/update body into columns. `existing` is null on create. */
  private async fields(
    dto: UpdateIdentityProviderDto,
    principal: Principal,
    existing: IdentityProvider | null,
  ): Promise<Omit<Prisma.IdentityProviderUncheckedCreateInput, 'workspaceId' | 'kind' | 'name'>> {
    // Platform-wide reaches every workspace's login page: only someone who may act on all of them sets it.
    if (dto.platformWide !== undefined && dto.platformWide !== (existing?.platformWide ?? false) && !principal.isAdmin) {
      throw new ForbiddenException(t('error.sso.platformWideAdminOnly'));
    }

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

    let allowedDomains: string[] | undefined;
    if (dto.allowedDomains) {
      allowedDomains = [];
      for (const raw of dto.allowedDomains) {
        const domain = normalizeDomain(raw);
        if (!domain) throw new BadRequestException(t('error.sso.invalidDomain', { domain: raw.slice(0, 100) }));
        if (!allowedDomains.includes(domain)) allowedDomains.push(domain);
      }
    }

    let secretCipher: string | null | undefined;
    if (dto.clientSecret !== undefined) {
      if (dto.clientSecret === '') secretCipher = null;
      else {
        try {
          secretCipher = encryptSecret(dto.clientSecret, this.key);
        } catch (e) {
          if (e instanceof MissingEncryptionKeyError) throw new BadRequestException(t('error.sso.secretKeyMissing'));
          throw e;
        }
      }
    }

    return {
      preset,
      config: { issuer: OIDC_PRESETS[preset].issuer ?? issuer, clientId, scopes },
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.showOnLogin !== undefined ? { showOnLogin: dto.showOnLogin } : {}),
      ...(dto.platformWide !== undefined ? { platformWide: dto.platformWide } : {}),
      ...(dto.jitEnabled !== undefined ? { jitEnabled: dto.jitEnabled } : {}),
      ...(dto.defaultRole !== undefined ? { defaultRole: dto.defaultRole } : {}),
      ...(allowedDomains ? { allowedDomains } : {}),
      ...(dto.groupsClaim !== undefined ? { groupsClaim: dto.groupsClaim?.trim() || null } : {}),
      ...(dto.groupSyncMode !== undefined ? { groupSyncMode: dto.groupSyncMode } : {}),
      ...(dto.sessionTtlHours !== undefined ? { sessionTtlHours: dto.sessionTtlHours } : {}),
      ...(secretCipher !== undefined ? { secretCipher } : {}),
    };
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
      hasSecret: r.secretCipher !== null,
      jitEnabled: r.jitEnabled,
      defaultRole: (WORKSPACE_ROLES as readonly string[]).includes(r.defaultRole ?? '') ? (r.defaultRole as WorkspaceRole) : null,
      allowedDomains: r.allowedDomains,
      groupsClaim: r.groupsClaim,
      groupSyncMode: (GROUP_SYNC_MODES as readonly string[]).includes(r.groupSyncMode) ? (r.groupSyncMode as GroupSyncMode) : 'additive',
      sessionTtlHours: r.sessionTtlHours,
      redirectUri: this.oidc.redirectUri(r.id),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}


/** Which fields a body set, by name — the secret only as "the secret changed", never its value. */
function changedFields(dto: UpdateIdentityProviderDto): string[] {
  const set = AUDITED_FIELDS.filter((f) => (dto as Record<string, unknown>)[f] !== undefined) as string[];
  return dto.clientSecret !== undefined ? [...set, 'clientSecret'] : set;
}
