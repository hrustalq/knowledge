import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type IdentityProvider, type SsoDomain } from '@prisma/client';
import type { ListSsoDomainsResponse, SsoDomainView, VerifySsoDomainResponse } from '@knowledge/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { t } from '../../i18n/t.js';
import { AuditService } from '../audit.service.js';
import { AuthPolicyService } from '../auth-policy.service.js';
import type { Principal } from '../principal.js';
import type { ClaimSsoDomainDto, UpdateSsoDomainDto } from './enforcement.dto.js';
import { normalizeDomain } from './identity-providers.service.js';
import { CHALLENGE_LABEL, DNS_TXT_LOOKUP, proveDomain, type TxtLookup } from './sso-dns.js';

/** How long a pending claim is rechecked by the sweeper — and how long it holds the domain against another workspace. */
export const DOMAIN_RECHECK_MS = 7 * 24 * 3_600_000;

type DomainRow = SsoDomain & { provider: IdentityProvider | null };

/**
 * Email domains a workspace claims (#75 phase 4), Settings → Security → Domains.
 *
 * A claim proves nothing until DNS does: `_knowledge-challenge.<domain>` must
 * carry the claim's token, checked on demand here and every 15 minutes for a
 * week by `SsoMaintenanceSweeper`. A platform admin may mark one verified by
 * hand for an air-gapped install, audited. Only a verified domain can be
 * enforced, so an unproven claim can never lock password users out.
 *
 * A domain belongs to one workspace at a time (it is the table's key). A
 * pending claim older than the recheck window no longer holds it, so a
 * squatter's abandoned claim cannot block the domain's real owner.
 */
@Injectable()
export class SsoDomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: AuthPolicyService,
    @Inject(DNS_TXT_LOOKUP) private readonly lookup: TxtLookup,
  ) {}

  async list(workspaceId: string, principal: Principal): Promise<ListSsoDomainsResponse> {
    const [rows, providers] = await Promise.all([
      this.prisma.ssoDomain.findMany({ where: { workspaceId }, include: { provider: true }, orderBy: { domain: 'asc' } }),
      this.prisma.identityProvider.findMany({
        where: this.assignable(workspaceId),
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true },
      }),
    ]);
    return { domains: rows.map((r) => this.view(r)), providers, canVerifyManually: principal.isAdmin };
  }

  async claim(workspaceId: string, dto: ClaimSsoDomainDto, principal: Principal): Promise<SsoDomainView> {
    const domain = normalizeDomain(dto.domain);
    if (!domain) throw new BadRequestException(t('error.sso.invalidDomain', { domain: dto.domain.slice(0, 100) }));
    const providerId = dto.providerId ? await this.assignableProvider(workspaceId, dto.providerId) : null;

    const existing = await this.prisma.ssoDomain.findUnique({ where: { domain }, include: { provider: true } });
    if (existing?.workspaceId === workspaceId) return this.view(existing); // claiming it again changes nothing
    if (existing) {
      // An abandoned pending claim gives way; one guarded delete, so two
      // claimants racing for it cannot both take it.
      const { count } = await this.prisma.ssoDomain.deleteMany({
        where: { domain, verifiedAt: null, createdAt: { lt: new Date(Date.now() - DOMAIN_RECHECK_MS) } },
      });
      if (count === 0) throw new ConflictException(t('error.sso.domainTaken', { domain }));
    }
    let row: DomainRow;
    try {
      row = await this.prisma.ssoDomain.create({
        data: { domain, workspaceId, providerId, verificationToken: `knowledge-verification=${randomBytes(18).toString('base64url')}` },
        include: { provider: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(t('error.sso.domainTaken', { domain }));
      }
      throw e;
    }
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'sso.domain_claimed',
      params: { domain, providerId, replacedStaleClaim: existing ? existing.workspaceId : null },
      ok: true,
      target: domain,
    });
    return this.view(row);
  }

  /** Check DNS now — or, for a platform admin asking `manual`, take their word for it. */
  async verify(workspaceId: string, raw: string, principal: Principal, manual = false): Promise<VerifySsoDomainResponse> {
    const row = await this.find(workspaceId, raw);
    if (row.verifiedAt) return { domain: this.view(row), error: null };
    if (manual) {
      if (!principal.isAdmin) throw new ForbiddenException(t('error.sso.manualVerifyAdminOnly'));
      return { domain: await this.markVerified(row, principal.userId, 'manual'), error: null };
    }
    const proof = await proveDomain(this.lookup, row.domain, row.verificationToken);
    if (proof !== 'ok') return { domain: this.view(row), error: proof };
    return { domain: await this.markVerified(row, principal.userId, 'dns'), error: null };
  }

  async update(workspaceId: string, raw: string, dto: UpdateSsoDomainDto, principal: Principal): Promise<SsoDomainView> {
    const row = await this.find(workspaceId, raw);
    const providerId =
      dto.providerId === undefined ? row.providerId : dto.providerId === null ? null : await this.assignableProvider(workspaceId, dto.providerId);
    const enforced = dto.enforced ?? row.enforced;
    if (enforced && !row.enforced) {
      if (!row.verifiedAt) throw new BadRequestException(t('error.sso.domainNotVerified', { domain: row.domain }));
      // Somewhere to send the domain's people, or enforcing it is a lockout.
      const live = await this.policy.providersFor(workspaceId);
      if (providerId ? !live.some((p) => p.id === providerId) : !live.length) {
        throw new BadRequestException(t('error.sso.domainNoProvider', { domain: row.domain }));
      }
    }
    const updated = await this.prisma.ssoDomain.update({
      where: { domain: row.domain },
      data: { enforced, providerId },
      include: { provider: true },
    });
    const entry = {
      workspaceId,
      actor: principal.userId,
      params: { domain: row.domain, enforced, providerId, previous: { enforced: row.enforced, providerId: row.providerId } },
      ok: true,
      target: row.domain,
    };
    // Turning enforcement on or off is its own action: it is the one an auditor looks for.
    if (enforced !== row.enforced) void this.audit.record({ ...entry, action: 'sso.domain_enforced' });
    else void this.audit.record({ ...entry, action: 'sso.domain_updated' });
    return this.view(updated);
  }

  async remove(workspaceId: string, raw: string, principal: Principal): Promise<void> {
    const row = await this.find(workspaceId, raw);
    await this.prisma.ssoDomain.delete({ where: { domain: row.domain } });
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'sso.domain_removed',
      params: { domain: row.domain, wasVerified: row.verifiedAt !== null, wasEnforced: row.enforced },
      ok: true,
      target: row.domain,
    });
  }

  /**
   * The sweeper's pass: pending claims still inside their window, oldest
   * first. Returns how many it proved. A lookup failure is left for the next tick.
   */
  async recheckPending(limit = 50): Promise<number> {
    const rows = await this.prisma.ssoDomain.findMany({
      where: { verifiedAt: null, createdAt: { gte: new Date(Date.now() - DOMAIN_RECHECK_MS) } },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let proved = 0;
    for (const row of rows) {
      if ((await proveDomain(this.lookup, row.domain, row.verificationToken)) !== 'ok') continue;
      await this.markVerified(row, 'sso-maintenance', 'dns');
      proved++;
    }
    return proved;
  }

  /** One guarded statement: a sweep and a click proving the same domain at once audit it once. */
  private async markVerified(row: DomainRow, actor: string, method: 'dns' | 'manual'): Promise<SsoDomainView> {
    const now = new Date();
    const { count } = await this.prisma.ssoDomain.updateMany({
      where: { domain: row.domain, workspaceId: row.workspaceId, verifiedAt: null },
      data: { verifiedAt: now },
    });
    if (count > 0) {
      void this.audit.record({
        workspaceId: row.workspaceId,
        actor,
        action: 'sso.domain_verified',
        params: { domain: row.domain, method },
        ok: true,
        target: row.domain,
      });
    }
    const fresh = await this.prisma.ssoDomain.findUnique({ where: { domain: row.domain }, include: { provider: true } });
    return this.view(fresh ?? { ...row, verifiedAt: now });
  }

  /** Another workspace's domain is a 404 here, not a 409 that confirms who holds it. */
  private async find(workspaceId: string, raw: string): Promise<DomainRow> {
    const domain = normalizeDomain(raw);
    const row = domain ? await this.prisma.ssoDomain.findFirst({ where: { domain, workspaceId }, include: { provider: true } }) : null;
    if (!row) throw new NotFoundException(t('error.sso.domainNotFound'));
    return row;
  }

  private async assignableProvider(workspaceId: string, providerId: string): Promise<string> {
    const provider = await this.prisma.identityProvider.findFirst({ where: { id: providerId, ...this.assignable(workspaceId) }, select: { id: true } });
    if (!provider) throw new BadRequestException(t('error.sso.domainProvider'));
    return provider.id;
  }

  /** Providers a domain may send people to: the workspace's own, and every platform-wide one. */
  private assignable(workspaceId: string): Prisma.IdentityProviderWhereInput {
    return { OR: [{ workspaceId }, { platformWide: true }] };
  }

  private view(r: DomainRow): SsoDomainView {
    return {
      domain: r.domain,
      workspaceId: r.workspaceId,
      providerId: r.providerId,
      providerName: r.provider?.name ?? null,
      recordName: `${CHALLENGE_LABEL}.${r.domain}`,
      verificationToken: r.verificationToken,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      enforced: r.enforced,
      createdAt: r.createdAt.toISOString(),
      recheckUntil: r.verifiedAt ? null : new Date(r.createdAt.getTime() + DOMAIN_RECHECK_MS).toISOString(),
    };
  }
}
