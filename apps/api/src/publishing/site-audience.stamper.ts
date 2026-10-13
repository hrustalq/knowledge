import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  foldSiteAudience,
  normalizeAudienceClaims,
  type SiteAudienceRuleInput,
  type SiteAudienceRuleKind,
  type SiteAudienceStamp,
} from '@knowledge/contracts';
import { hasRealPath } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type SiteAudienceRules = ReadonlyMap<string, SiteAudienceRuleInput>;

/** A page's ids from the top of the tree down to itself, by `documents.path`; just itself when the path is not set yet. */
export function pathIds(documentId: string, path: string | null | undefined): string[] {
  return path && hasRealPath(path) ? path.split('/').filter(Boolean) : [documentId];
}

/**
 * Writes a site's audience rules onto its snapshot rows (issue #77 phase 3).
 *
 * The rules live per site; the reader filters on the rows alone. So every
 * change to a rule restamps every version, frozen ones included — what a
 * frozen version freezes is its content, not who may read it — and a build
 * stamps the rows it writes. Both use `foldSiteAudience` over the page's
 * `documents.path`, so a page that moved is judged where it is now.
 *
 * In PublishingCoreModule because both processes stamp: the API on a rule
 * change, the worker in a build and when a page moves.
 */
@Injectable()
export class SiteAudienceStamper {
  constructor(private readonly prisma: PrismaService) {}

  async rules(siteId: string): Promise<SiteAudienceRules> {
    const rows = await this.prisma.siteAudienceRule.findMany({
      where: { siteId },
      select: { documentId: true, audience: true, claims: true },
    });
    return new Map(
      rows.map((r) => [r.documentId, { audience: r.audience as SiteAudienceRuleKind, claims: normalizeAudienceClaims(r.claims) }]),
    );
  }

  stampFor(documentId: string, path: string | null | undefined, rules: SiteAudienceRules): SiteAudienceStamp {
    return foldSiteAudience(pathIds(documentId, path), rules);
  }

  /** The columns a stamp writes. */
  static columns(stamp: SiteAudienceStamp): { audience: string; audienceClaims: Prisma.InputJsonValue | typeof Prisma.DbNull } {
    return { audience: stamp.audience, audienceClaims: stamp.claims ? (stamp.claims as Prisma.InputJsonValue) : Prisma.DbNull };
  }

  /**
   * Restamp a site's snapshot rows from its rules as they are now: every
   * version, or one. Rows are grouped by stamp, one statement per group, in
   * one transaction — a site has few distinct stamps however many pages.
   */
  async restamp(siteId: string, versionId?: string): Promise<void> {
    const versionIds = versionId
      ? [versionId]
      : (await this.prisma.siteVersion.findMany({ where: { siteId }, select: { id: true } })).map((v) => v.id);
    if (!versionIds.length) return;
    const documentIds = (
      await this.prisma.siteVersionPage.findMany({
        where: { versionId: { in: versionIds } },
        distinct: ['documentId'],
        select: { documentId: true },
      })
    ).map((r) => r.documentId);
    if (!documentIds.length) return;

    const [rules, docs] = await Promise.all([
      this.rules(siteId),
      this.prisma.document.findMany({ where: { id: { in: documentIds } }, select: { id: true, path: true } }),
    ]);
    const pathOf = new Map(docs.map((d) => [d.id, d.path]));
    const groups = new Map<string, { stamp: SiteAudienceStamp; ids: string[] }>();
    for (const id of documentIds) {
      const stamp = this.stampFor(id, pathOf.get(id), rules);
      const key = JSON.stringify(stamp);
      const group = groups.get(key) ?? { stamp, ids: [] };
      group.ids.push(id);
      groups.set(key, group);
    }
    await this.prisma.$transaction(
      [...groups.values()].map((g) =>
        this.prisma.siteVersionPage.updateMany({
          where: { versionId: { in: versionIds }, documentId: { in: g.ids } },
          data: SiteAudienceStamper.columns(g.stamp),
        }),
      ),
    );
  }
}
