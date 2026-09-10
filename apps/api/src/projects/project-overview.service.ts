import { Injectable } from '@nestjs/common';
import type {
  ProjectContributor,
  ProjectOverviewResponse,
  ProjectSummary,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from './projects.service.js';

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

  async get(projectId: string): Promise<ProjectOverviewResponse> {
    const project = await this.projects.get(projectId);
    const [contributors, counts, recentPages] = await Promise.all([
      this.contributorsFor(projectId),
      this.countsFor(project),
      this.recentPagesFor(projectId),
    ]);
    return { project, contributors, counts, recentPages };
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
  private async contributorsFor(projectId: string): Promise<ProjectContributor[]> {
    const revisions = await this.prisma.documentRevision.findMany({
      where: { document: { projectId } },
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
  private async countsFor(project: ProjectSummary): Promise<ProjectOverviewResponse['counts']> {
    const [glossaryTerms, connectors, workflows, openMergeRequests] = await Promise.all([
      this.prisma.glossaryTerm.count({ where: { projectId: project.projectId } }),
      this.prisma.connector.count({ where: { projectId: project.projectId } }),
      this.prisma.workflowDefinition.count({ where: { workspaceId: project.workspaceId } }),
      this.prisma.mergeRequest.count({
        where: { status: 'open', document: { projectId: project.projectId } },
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

  private async recentPagesFor(
    projectId: string,
  ): Promise<ProjectOverviewResponse['recentPages']> {
    // "Updated" means the newest revision, not documents.created_at — a page
    // written a year ago and revised yesterday is the recent one.
    const revisions = await this.prisma.documentRevision.findMany({
      where: { document: { projectId } },
      select: { documentId: true, createdAt: true, document: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
      take: REVISION_SCAN,
    });
    const seen = new Map<string, { documentId: string; title: string; updatedAt: string }>();
    for (const revision of revisions) {
      if (seen.has(revision.documentId)) continue;
      seen.set(revision.documentId, {
        documentId: revision.documentId,
        title: revision.document.title,
        updatedAt: revision.createdAt.toISOString(),
      });
      if (seen.size >= RECENT_PAGES) break;
    }
    return [...seen.values()];
  }
}
