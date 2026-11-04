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

  /** A page restricted since it was published is withheld from every reader, frozen versions included (#760). */
  stampFor(documentId: string, path: string | null | undefined, rules: SiteAudienceRules, restrictedBy: readonly string[] = []): SiteAudienceStamp {
    if (restrictedBy.length > 0) return { audience: 'withheld', claims: null };
    return foldSiteAudience(pathIds(documentId, path), rules);
  }

  /** The columns a stamp writes. */
  static columns(stamp: SiteAudienceStamp): { audience: string; audienceClaims: Prisma.InputJsonValue | typeof Prisma.DbNull } {
    return { audience: stamp.audience, audienceClaims: stamp.claims ? (stamp.claims as Prisma.InputJsonValue) : Prisma.DbNull };
  }

  /**
   * Restamp a site's snapshot rows from its rules as they are now: every
   * version, or one. Rows are grouped by stamp, one statement per group, in
   * one transaction — a site has few distinct stamps however many pages. Lifting
   * a restriction lands here too, so a frozen version gets its page back.
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
      this.prisma.document.findMany({ where: { id: { in: documentIds } }, select: { id: true, path: true, restrictedBy: true } }),
    ]);
    const docOf = new Map(docs.map((d) => [d.id, d]));
    const groups = new Map<string, { stamp: SiteAudienceStamp; ids: string[] }>();
    for (const id of documentIds) {
      const stamp = this.stampFor(id, docOf.get(id)?.path, rules, docOf.get(id)?.restrictedBy);
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

  /**
   * Restamp every site that publishes this page, once each across `done`. A
   * page's restriction changed: the ACL sweeper is the one place every path to
   * `restricted_by` passes through, connector mirroring and project switches included.
   */
  async restampPublishing(documentId: string, done: Set<string>): Promise<void> {
    const sites = await this.prisma.publishedSite.findMany({
      where: { versions: { some: { pages: { some: { documentId } } } } },
      select: { id: true },
    });
    for (const { id } of sites) {
      if (done.has(id)) continue;
      await this.restamp(id);
      done.add(id);
    }
  }
}
