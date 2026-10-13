import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PublishedSite } from '@prisma/client';
import {
  normalizeAudienceClaims,
  siteAudienceClaimsErrors,
  type SiteAudienceClaims,
  type SiteAudienceRule,
  type SiteAudienceRuleKind,
  type SiteAudiencesResponse,
  type SiteVisitorSecretResponse,
} from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import { encryptSecret, parseKey } from '../ai/secret-box.js';
import type { Env } from '../config/env.js';
import { hasRealPath } from '../documents/documents.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SiteAudienceStamper } from './site-audience.stamper.js';

/** The dev principal has no users row; same stub the rest of the API records. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/** Most rules one site keeps. A rule covers a subtree, so a site needs a handful. */
export const SITE_MAX_AUDIENCE_RULES = 200;

export interface SetAudienceRuleInput {
  audience: SiteAudienceRuleKind;
  claims?: SiteAudienceClaims | null;
}

/**
 * Who may read which part of a published site (issue #77 phase 3,
 * docs/features/44): the rules, and the secret a customer's backend signs
 * visitor tokens with. Admin-only, like everything that changes what the
 * public sees.
 *
 * A rule takes effect at once on every version: each write restamps the
 * site's snapshot rows (`SiteAudienceStamper`) before it answers, so the next
 * read is already filtered — no build, and no reader cache to wait out.
 */
@Injectable()
export class SiteAudiencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stamper: SiteAudienceStamper,
    private readonly activity: ActivityService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(siteId: string): Promise<SiteAudiencesResponse> {
    const site = await this.requireSite(siteId);
    const rules = await this.prisma.siteAudienceRule.findMany({
      where: { siteId },
      include: { document: { select: { title: true, path: true } } },
    });
    // Tree order, so a rule reads above the rules beneath it.
    rules.sort((a, b) => a.document.path.localeCompare(b.document.path));
    return {
      rules: rules.map((r) => this.toRule(r)),
      visitorAuth: {
        configured: !!site.visitorSecretCipher,
        setAt: site.visitorSecretSetAt?.toISOString() ?? null,
        canStore: !!this.secretKey(),
      },
      sessionTtlMinutes: this.config.get('SITE_VISITOR_TTL_MIN', { infer: true }),
    };
  }

  async setRule(siteId: string, documentId: string, input: SetAudienceRuleInput, actorId?: string): Promise<SiteAudienceRule> {
    const site = await this.requireSite(siteId);
    const document = await this.requirePageInSite(site, documentId);
    let claims: SiteAudienceClaims | null = null;
    if (input.audience === 'visitors') {
      const errors = siteAudienceClaimsErrors(input.claims);
      if (errors.length) {
        throw new BadRequestException({
          statusCode: 400,
          message: t('error.site.audienceClaimsInvalid', { fields: errors.join(', ') }),
          reason: 'site.audienceClaimsInvalid',
          fields: errors,
        });
      }
      claims = normalizeAudienceClaims(input.claims);
    } else if (input.claims && Object.keys(input.claims).length) {
      // Claims mean nothing to members; refusing them beats storing a rule that reads as if they did.
      throw new BadRequestException({
        statusCode: 400,
        message: t('error.site.audienceClaimsMembers'),
        reason: 'site.audienceClaimsInvalid',
        fields: ['claims'],
      });
    }
    const count = await this.prisma.siteAudienceRule.count({ where: { siteId, NOT: { documentId } } });
    if (count >= SITE_MAX_AUDIENCE_RULES) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.site.audienceRuleLimit', { max: SITE_MAX_AUDIENCE_RULES }),
        reason: 'site.audienceRuleLimit',
      });
    }

    const json = claims ? (claims as Prisma.InputJsonValue) : Prisma.DbNull;
    const row = await this.prisma.siteAudienceRule.upsert({
      where: { siteId_documentId: { siteId, documentId } },
      create: { siteId, documentId, audience: input.audience, claims: json, createdBy: actorId ?? AUTHOR_ID_STUB },
      update: { audience: input.audience, claims: json },
    });
    await this.stamper.restamp(siteId);
    this.record(site, 'site.audience.updated', actorId, { documentId, audience: input.audience });
    return this.toRule({ ...row, document });
  }

  async removeRule(siteId: string, documentId: string, actorId?: string): Promise<{ deleted: true }> {
    const site = await this.requireSite(siteId);
    const { count } = await this.prisma.siteAudienceRule.deleteMany({ where: { siteId, documentId } });
    if (!count) throw new NotFoundException(t('error.site.audienceRuleNotFound'));
    await this.stamper.restamp(siteId);
    this.record(site, 'site.audience.removed', actorId, { documentId });
    return { deleted: true };
  }

  /**
   * A new visitor secret, shown this once. Replacing it ends every visitor
   * session at once (they are bound to the secret they were opened under) and
   * makes tokens signed with the old one worthless.
   */
  async rotateVisitorSecret(siteId: string, actorId?: string): Promise<SiteVisitorSecretResponse> {
    const site = await this.requireSite(siteId);
    const key = this.secretKey();
    if (!key) {
      throw new ConflictException({ statusCode: 409, message: t('error.site.visitorSecretNeedsKey'), reason: 'site.visitorSecretNeedsKey' });
    }
    const secret = randomBytes(32).toString('base64url');
    const setAt = new Date();
    await this.prisma.publishedSite.update({
      where: { id: siteId },
      data: { visitorSecretCipher: encryptSecret(secret, key), visitorSecretSetAt: setAt },
    });
    this.record(site, 'site.visitorSecret.rotated', actorId);
    return { secret, setAt: setAt.toISOString() };
  }

  /** Turn visitor sign-in off: open visitor sessions end, and `visitors` pages are for members only until a secret is set again. */
  async clearVisitorSecret(siteId: string, actorId?: string): Promise<{ deleted: true }> {
    const site = await this.requireSite(siteId);
    await this.prisma.publishedSite.update({ where: { id: siteId }, data: { visitorSecretCipher: null, visitorSecretSetAt: null } });
    this.record(site, 'site.visitorSecret.cleared', actorId);
    return { deleted: true };
  }

  // -------------------------------------------------------------------------

  private secretKey(): Buffer | null {
    try {
      return parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    } catch {
      return null;
    }
  }

  private async requireSite(siteId: string): Promise<PublishedSite> {
    const site = await this.prisma.publishedSite.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException(t('error.site.notFound'));
    return site;
  }

  /** A live page the site covers: in its project and, for a site published from one page, at or under that page. */
  private async requirePageInSite(site: PublishedSite, documentId: string): Promise<{ title: string; path: string }> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { title: true, path: true, projectId: true, archivedAt: true },
    });
    const inSite =
      !!doc &&
      !doc.archivedAt &&
      doc.projectId === site.projectId &&
      (!site.rootDocumentId || (hasRealPath(doc.path) && doc.path.includes(`/${site.rootDocumentId}/`)));
    if (!inSite) {
      throw new BadRequestException({ statusCode: 400, message: t('error.site.audiencePageNotInSite'), reason: 'site.audiencePageNotInSite' });
    }
    return { title: doc.title, path: doc.path };
  }

  private toRule(r: {
    documentId: string;
    audience: string;
    claims: Prisma.JsonValue;
    updatedAt: Date;
    document: { title: string };
  }): SiteAudienceRule {
    return {
      documentId: r.documentId,
      documentTitle: r.document.title,
      audience: r.audience as SiteAudienceRuleKind,
      claims: r.audience === 'visitors' ? normalizeAudienceClaims(r.claims) : null,
      updatedAt: r.updatedAt.toISOString(),
    };
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
