import { Injectable } from '@nestjs/common';
import {
  verificationStateFor,
  type ProjectContributor,
  type ProjectOverviewResponse,
  type ProjectSummary,
  type HomeRecentPage,
  type RevisionStatus,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from './projects.service.js';
import type { Prisma } from '@prisma/client';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { LISTED_PAGE } from '../common/listed-page.js';
import { openIssueCountsOf } from '../feedback/provenance.service.js';
import { sourceSyncOf } from '../documents/source-backed.js';

/** Enough people to be a roster, not a directory. The rail links out for the rest. */
const CONTRIBUTOR_LIMIT = 12;
/**
 * Revisions to read when deriving contributors. Revisions cluster heavily per
 * author, so this covers a busy project's recent history without paging — the
 * cap `ProfilesService.pagesFor` uses, for the same reason.
 */
const REVISION_SCAN = 800;
const RECENT_PAGES = 8;

/**
 * What a project *is* (docs/features/24).
 *
 * Derived on every request with no stored table, exactly as `ProfilesService`
 * is — every number here is a count over rows that already exist, and a cached
 * copy would only create a second answer to the same question.
 *
 * Split from `ProjectsService` rather than added to it: that service is in
 * `ProjectsCoreModule` because the worker needs `requireProjectInWorkspace`,
 * and none of this belongs in a worker.
 */
@Injectable()
export class ProjectOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * Every number and name here is over pages `scope` may open (#76): a
   * contributor known only for a restricted page, or its title in "recent",
   * would describe what the page restriction hides.
   */
  async get(projectId: string, scope: AccessScope): Promise<ProjectOverviewResponse> {
    const project = await this.projects.get(projectId, scope);
    const visible = visibilityWhere(scope);
    // A capture still behind its merge request is not a page here yet (#642);
    // the open-MR count keeps it, since that merge request is what it is.
    const listed: Prisma.DocumentWhereInput = { ...LISTED_PAGE, AND: [visible] };
    const [contributors, counts, recent] = await Promise.all([
      this.contributorsFor(projectId, listed),
      this.countsFor(project, visible),
      recentPages(this.prisma, { projectId, ...listed }),
    ]);
    return { project, contributors, counts, recentPages: recent };
  }

  /**
   * Who works here, derived from what they have actually done.
   *
   * Projects hold no members and are not going to (docs/features/11:
   * "organizational only") — a second ACL layer under the workspace boundary
   * would be a new authorization surface for no gain. So this is not a
   * membership list: it is the people who have revised a page in this project,
   * which has the useful property of staying true with nobody maintaining it.
   *
   * Documents carry no author column, so authorship comes from revisions —
   * the same derivation `ProfilesService.pagesFor` makes in the other direction.
   * Ids only: the client already has the member roster cached for names and
   * faces, so re-sending them here would be a second copy that can disagree.
   */
  private async contributorsFor(projectId: string, visible: Prisma.DocumentWhereInput): Promise<ProjectContributor[]> {
    const revisions = await this.prisma.documentRevision.findMany({
      where: { document: { projectId, AND: [visible] } },
      select: { authorId: true, documentId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: REVISION_SCAN,
    });

    const byAuthor = new Map<string, { pages: Set<string>; lastActiveAt: Date }>();
    for (const revision of revisions) {
      const existing = byAuthor.get(revision.authorId);
      if (existing) {
        existing.pages.add(revision.documentId);
        continue;
      }
      // Rows arrive newest-first, so the first one seen for an author is their
      // most recent — no comparison needed.
      byAuthor.set(revision.authorId, {
        pages: new Set([revision.documentId]),
        lastActiveAt: revision.createdAt,
      });
    }

    return [...byAuthor.entries()]
      .map(([userId, v]) => ({
        userId,
        pageCount: v.pages.size,
        lastActiveAt: v.lastActiveAt.toISOString(),
      }))
      // Most pages first, then most recent: the question a reader is asking is
      // "who should I ask about this", and that is closer to volume than to
      // whoever happened to fix a typo this morning.
      .sort((a, b) => b.pageCount - a.pageCount || b.lastActiveAt.localeCompare(a.lastActiveAt))
      .slice(0, CONTRIBUTOR_LIMIT);
  }

  /**
   * The numbers the rail collapses to.
   *
   * Counts rather than rows: each one decides whether a widget is worth opening,
   * and fetching the contents of six widgets to render six numbers is what a
   * preview query exists to avoid (feature 15).
   */
  private async countsFor(
    project: ProjectSummary,
    visible: Prisma.DocumentWhereInput,
  ): Promise<ProjectOverviewResponse['counts']> {
    const [glossaryTerms, connectors, workflows, openMergeRequests] = await Promise.all([
      this.prisma.glossaryTerm.count({ where: { projectId: project.projectId } }),
      this.prisma.connector.count({ where: { projectId: project.projectId } }),
      this.prisma.workflowDefinition.count({ where: { workspaceId: project.workspaceId } }),
      this.prisma.mergeRequest.count({
        where: { status: 'open', document: { projectId: project.projectId, AND: [visible] } },
      }),
    ]);
    return {
      // Already counted by the summary's own `_count`, so it is not re-queried.
      documents: project.documentCount,
      glossaryTerms,
      connectors,
      workflows,
      openMergeRequests,
    };
  }
}

/**
 * The newest-revised pages under `where` (also the workspace home's, #1243).
 * "Updated" means the newest revision, not documents.created_at — a page
 * written a year ago and revised yesterday is the recent one.
 *
 * Each row carries what a tree row draws (#1293): the head's lifecycle status
 * and `verificationStateFor` over the same inputs the tree reads.
 */
export async function recentPages(
  prisma: PrismaService,
  where: Prisma.DocumentWhereInput,
): Promise<HomeRecentPage[]> {
  const revisions = await prisma.documentRevision.findMany({
    where: { document: where },
    select: { documentId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: REVISION_SCAN,
  });
  const updatedAt = new Map<string, Date>();
  for (const revision of revisions) {
    if (!updatedAt.has(revision.documentId)) updatedAt.set(revision.documentId, revision.createdAt);
    if (updatedAt.size >= RECENT_PAGES) break;
  }
  const ids = [...updatedAt.keys()];
  if (ids.length === 0) return [];
  const [docs, issues, sources] = await Promise.all([
    prisma.document.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        defaultBranch: true,
        verificationFlag: true,
        verifiedRevisionId: true,
        verificationExpiresAt: true,
        branches: { select: { name: true, headRevisionId: true } },
      },
    }),
    openIssueCountsOf(prisma, ids),
    sourceSyncOf(prisma, ids),
  ]);
  const headOf = new Map(
    docs.map((d) => [d.id, d.branches.find((b) => b.name === d.defaultBranch)?.headRevisionId ?? null]),
  );
  const headIds = [...headOf.values()].filter((h): h is string => !!h);
  const heads = await prisma.documentRevision.findMany({
    where: { id: { in: headIds } },
    select: { id: true, status: true },
  });
  const statusOf = new Map(heads.map((r) => [r.id, r.status as RevisionStatus]));
  const byId = new Map(docs.map((d) => [d.id, d]));
  return ids.flatMap((id) => {
    const d = byId.get(id);
    if (!d) return [];
    const headId = headOf.get(id) ?? null;
    return [
      {
        documentId: id,
        title: d.title,
        updatedAt: updatedAt.get(id)!.toISOString(),
        headRevisionStatus: (headId && statusOf.get(headId)) || null,
        verification: verificationStateFor({ ...d, source: sources.get(id) }, headId, issues.get(id) ?? 0),
      },
    ];
  });
}
