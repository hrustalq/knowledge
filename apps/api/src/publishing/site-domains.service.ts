import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PublishedSite, type SiteDomain } from '@prisma/client';
import {
  SITE_DOMAIN_TXT_LABEL,
  SITE_DOMAIN_TXT_PREFIX,
  SITE_MAX_DOMAINS,
  normalizeHostname,
  type SiteDomainCheckError,
  type SiteDomainSummary,
} from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The dev principal has no users row; same stub the rest of the API records. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/** DNS errors that are an answer ("no such record"), as opposed to DNS not answering. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN']);

export type DomainCheck = { ok: true } | { ok: false; error: SiteDomainCheckError };

/** A domain row as an admin sees it, with the DNS records to create. */
export function siteDomainSummary(
  domain: SiteDomain,
  site: Pick<PublishedSite, 'slug'>,
  opts: { baseDomain: string; webBaseUrl: string },
): SiteDomainSummary {
  let webHost = '';
  try {
    webHost = new URL(opts.webBaseUrl).hostname;
  } catch {
    /* an unparsable WEB_BASE_URL leaves the target blank rather than failing the page */
  }
  return {
    id: domain.id,
    hostname: domain.hostname,
    verified: domain.verifiedAt !== null,
    verifiedAt: domain.verifiedAt?.toISOString() ?? null,
    lastCheckAt: domain.lastCheckAt?.toISOString() ?? null,
    lastError: (domain.lastError as SiteDomainCheckError | null) ?? null,
    txtName: `${SITE_DOMAIN_TXT_LABEL}.${domain.hostname}`,
    txtValue: `${SITE_DOMAIN_TXT_PREFIX}${domain.verifyToken}`,
    dnsTarget: opts.baseDomain ? `${site.slug}.${opts.baseDomain}` : webHost,
    createdAt: domain.createdAt.toISOString(),
  };
}

/**
 * A site's own hostnames (docs/features/44, issue #77 phase 2b).
 *
 * A name is served — and the front proxy given a certificate for it — only
 * once its owner has proven control: a TXT record at `_knowledge.<hostname>`
 * holding the token issued here. Until then it is a claim and holds nothing,
 * so another site may replace an unproven claim on the same name; a verified
 * name is the first prover's until their admin removes it.
 *
 * Verified domains are not re-checked: a TXT record people delete after
 * verifying must not take their docs down a day later. The cost is that a
 * name whose owner changes stays with the site that proved it, until removed.
 *
 * API-only. `PublishingSweeper` re-checks pending names on its tick; an admin
 * can check now with Verify.
 */
@Injectable()
export class SiteDomainsService {
  private readonly resolver = new Resolver({ timeout: 5_000, tries: 2 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async add(siteId: string, rawHostname: string, actorId?: string): Promise<SiteDomainSummary> {
    this.requireEnabled();
    const site = await this.prisma.publishedSite.findUnique({ where: { id: siteId }, include: { domains: true } });
    if (!site) throw new NotFoundException(t('error.site.notFound'));
    const hostname = normalizeHostname(rawHostname);
    if (!hostname) throw new BadRequestException({ statusCode: 400, message: t('error.site.domainInvalid'), reason: 'site.domainInvalid' });
    if (this.isPlatformHost(hostname)) {
      throw new BadRequestException({ statusCode: 400, message: t('error.site.domainReserved', { hostname }), reason: 'site.domainReserved' });
    }
    if (site.domains.some((d) => d.hostname === hostname)) {
      throw new ConflictException({ statusCode: 409, message: t('error.site.domainExists', { hostname }), reason: 'site.domainExists' });
    }
    if (site.domains.length >= SITE_MAX_DOMAINS) {
      throw new ConflictException({ statusCode: 409, message: t('error.site.domainLimit', { max: SITE_MAX_DOMAINS }), reason: 'site.domainLimit' });
    }

    // An unproven claim by another site holds nothing: whoever proves control
    // first keeps the name. The guarded delete leaves a claim that was
    // verified in the meantime alone, and the insert below then 409s.
    await this.prisma.siteDomain.deleteMany({ where: { hostname, verifiedAt: null, siteId: { not: siteId } } });
    let domain: SiteDomain;
    try {
      domain = await this.prisma.siteDomain.create({
        data: { siteId, hostname, verifyToken: randomBytes(16).toString('hex'), createdBy: actorId ?? AUTHOR_ID_STUB },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw this.taken(hostname);
      throw e;
    }
    this.record(site, 'site.domain.added', actorId, { hostname });
    return this.summary(domain, site);
  }

  /** Check the TXT record now (an admin pressed Verify). Answers the domain either way; `lastError` says why not. */
  async verify(domainId: string, actorId?: string): Promise<SiteDomainSummary> {
    this.requireEnabled();
    const domain = await this.requireDomain(domainId);
    const checked = await this.check(domain, actorId);
    return this.summary(checked, domain.site);
  }

  async remove(domainId: string, actorId?: string): Promise<{ deleted: true }> {
    const domain = await this.requireDomain(domainId);
    await this.prisma.siteDomain.delete({ where: { id: domainId } });
    this.record(domain.site, 'site.domain.removed', actorId, { hostname: domain.hostname });
    return { deleted: true };
  }

  /**
   * Look the TXT record up and store the outcome. A pending domain becomes
   * verified when the record carries its token; a verified one is never
   * touched here (see the class comment). The write is guarded on
   * `verified_at IS NULL`, so a sweep and a click cannot both record it.
   */
  async check(domain: SiteDomain & { site: PublishedSite }, actorId?: string): Promise<SiteDomain> {
    if (domain.verifiedAt) return domain;
    const result = await this.lookup(domain.hostname, domain.verifyToken);
    const now = new Date();
    const data = result.ok
      ? { verifiedAt: now, lastCheckAt: now, lastError: null }
      : { lastCheckAt: now, lastError: result.error };
    const { count } = await this.prisma.siteDomain.updateMany({ where: { id: domain.id, verifiedAt: null }, data });
    if (result.ok && count === 1) this.record(domain.site, 'site.domain.verified', actorId, { hostname: domain.hostname });
    return (await this.prisma.siteDomain.findUnique({ where: { id: domain.id } })) ?? { ...domain, ...data };
  }

  /** Does `_knowledge.<hostname>` hold `<prefix><token>`? */
  async lookup(hostname: string, token: string): Promise<DomainCheck> {
    let records: string[][];
    try {
      records = await this.resolveTxt(`${SITE_DOMAIN_TXT_LABEL}.${hostname}`);
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      return { ok: false, error: NO_RECORD.has(code) ? 'txtMissing' : 'dnsError' };
    }
    // A long TXT value arrives split into 255-byte strings; joined, it is one value.
    const ours = records.map((r) => r.join('').trim()).filter((v) => v.startsWith(SITE_DOMAIN_TXT_PREFIX));
    if (ours.length === 0) return { ok: false, error: 'txtMissing' };
    return ours.some((v) => v.slice(SITE_DOMAIN_TXT_PREFIX.length).trim() === token)
      ? { ok: true }
      : { ok: false, error: 'txtMismatch' };
  }

  summary(domain: SiteDomain, site: Pick<PublishedSite, 'slug'>): SiteDomainSummary {
    return siteDomainSummary(domain, site, {
      baseDomain: this.config.get('PUBLISH_BASE_DOMAIN', { infer: true }),
      webBaseUrl: this.config.get('WEB_BASE_URL', { infer: true }),
    });
  }

  // -------------------------------------------------------------------------

  /** Overridden in specs; the real lookup asks the system's resolvers. */
  protected resolveTxt(name: string): Promise<string[][]> {
    return this.resolver.resolveTxt(name);
  }

  private requireEnabled(): void {
    if (!this.config.get('SITE_CUSTOM_DOMAINS', { infer: true })) {
      throw new ForbiddenException({ statusCode: 403, message: t('error.site.customDomainsOff'), reason: 'site.customDomainsOff' });
    }
  }

  /**
   * Names that already mean this platform: its own app and API hosts, the
   * site base domain and everything under it (those are `<slug>` subdomains,
   * routed by slug), and `.localhost`.
   */
  private isPlatformHost(hostname: string): boolean {
    const base = this.config.get('PUBLISH_BASE_DOMAIN', { infer: true });
    if (base && (hostname === base || hostname.endsWith(`.${base}`))) return true;
    if (hostname.endsWith('.localhost')) return true;
    for (const url of [this.config.get('WEB_BASE_URL', { infer: true }), this.config.get('API_PUBLIC_URL', { infer: true })]) {
      try {
        if (new URL(url).hostname === hostname) return true;
      } catch {
        /* not a URL: nothing to compare against */
      }
    }
    return false;
  }

  private async requireDomain(domainId: string): Promise<SiteDomain & { site: PublishedSite }> {
    const domain = await this.prisma.siteDomain.findUnique({ where: { id: domainId }, include: { site: true } });
    if (!domain) throw new NotFoundException(t('error.site.domainNotFound'));
    return domain;
  }

  private taken(hostname: string): ConflictException {
    return new ConflictException({ statusCode: 409, message: t('error.site.domainTaken', { hostname }), reason: 'site.domainTaken' });
  }

  private record(site: PublishedSite, action: string, actorId?: string, extra: Record<string, unknown> = {}): void {
    void this.activity.record({
      workspaceId: site.workspaceId,
      ...(actorId ? { actor: actorId } : {}),
      action,
      projectId: site.projectId,
      subjectId: site.id,
      metadata: { siteId: site.id, ...extra },
    });
  }
}
