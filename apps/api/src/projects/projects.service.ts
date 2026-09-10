import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  ProjectCascadeCounts,
  ProjectDeletionCounts,
  ProjectDeletionPreview,
  ProjectSummary,
} from '@knowledge/contracts';
import type { Project } from '@prisma/client';
import { ActivityService } from '../activity/activity.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { projectAvatarUrl } from '../common/avatar-url.js';
import type { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './projects.dto.js';
import { t } from '../i18n/t.js';

/**
 * Runs the destructive teardown. Passed in rather than injected: the machinery
 * needs object storage, the graph and the fulltext index, and this service
 * lives in `ProjectsCoreModule` so the worker can resolve projects while
 * writing pages. A seam keeps every invariant — the last-project rule, the
 * activity entry, the project row itself — in one place without dragging any
 * of that into the worker's module graph.
 */
export type CascadeRunner = (projectId: string, workspaceId: string) => Promise<ProjectCascadeCounts>;

/** The read-only half of the same seam: what a cascade *would* destroy. */
export type CascadeCounter = (projectId: string) => Promise<ProjectCascadeCounts>;

export interface RemoveOptions {
  /** Sibling project the contents move into. Required unless the project is empty. */
  moveContentsTo?: string;
  /** Present only for `mode=cascade`: supplied by the API-side controller. */
  cascade?: CascadeRunner;
  /** The project's name, echoed back. Required by a cascade, ignored by a move. */
  confirm?: string;
}

/** Nothing was destroyed, but the mode says a cascade ran. */
const ZERO_CASCADE: ProjectCascadeCounts = {
  documents: 0,
  revisions: 0,
  attachments: 0,
  mergeRequests: 0,
  discussions: 0,
  workflowRuns: 0,
  storedFiles: 0,
};

const ZERO_COUNTS: ProjectDeletionCounts = {
  documents: 0,
  glossaryTerms: 0,
  connectors: 0,
  workflowDefinitions: 0,
  activeWorkflowRuns: 0,
  pendingImports: 0,
  watchers: 0,
};

/**
 * Projects are the organizational layer between a workspace and its documents
 * (Workspace > Project > Document). They carry no ACLs of their own — role
 * checks happen in AclGuard via @Access(role, 'project' | 'body' | 'query').
 * What lives here are the invariants ACLs cannot express: a workspace always
 * keeps at least one project so there is somewhere to put a page, and a project
 * holding anything cannot simply vanish — its contents move first.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Cursor-paginated only when a `limit` is given: the workspace/project
   * switchers want the whole roster in one call, the projects rail pages it.
   */
  async list(query: ListProjectsQueryDto): Promise<ListProjectsResponse> {
    const search = query.search?.trim();
    const rows = await this.prisma.project.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { description: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { documents: true } } },
      ...(query.limit ? { take: query.limit + 1 } : {}),
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = query.limit !== undefined && rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      projects: page.map((p) => toSummary(p, p._count.documents)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async get(projectId: string): Promise<ProjectSummary> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { _count: { select: { documents: true } } },
    });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    return toSummary(project, project._count.documents);
  }

  async create(dto: CreateProjectDto, actorId?: string): Promise<CreateProjectResponse> {
    const project = await this.prisma.project.create({
      data: {
        workspaceId: dto.workspaceId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
      },
    });
    await this.activity.record({
      workspaceId: project.workspaceId,
      actor: actorId,
      action: 'project.created',
      subjectId: project.id,
      metadata: { name: project.name },
    });
    return { project: toSummary(project, 0) };
  }

  async update(projectId: string, dto: UpdateProjectDto, actorId?: string): Promise<ProjectSummary> {
    const project = await this.requireProject(projectId);

    const data: {
      name?: string;
      description?: string | null;
      avatarEmoji?: string | null;
      avatarColor?: string | null;
      avatarKey?: null;
      avatarUpdatedAt?: Date;
    } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.avatarEmoji !== undefined) {
      data.avatarEmoji = dto.avatarEmoji?.trim() || null;
      data.avatarUpdatedAt = new Date();
      // A project has one face. Choosing an emoji retires an uploaded picture,
      // the mirror of what AvatarsService does when a picture is uploaded.
      //
      // The S3 object is deliberately left behind rather than deleted here: this
      // service has no StorageService, and importing one so a rename can tidy a
      // bucket would put object storage on the path of every project edit. An
      // orphan costs a few kilobytes; DELETE .../avatar removes it properly.
      if (data.avatarEmoji) data.avatarKey = null;
    }
    if (dto.avatarColor !== undefined) data.avatarColor = dto.avatarColor?.trim() || null;
    if (Object.keys(data).length === 0) throw new BadRequestException(t('error.project.nothingToUpdate'));

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data,
      include: { _count: { select: { documents: true } } },
    });
    await this.activity.record({
      workspaceId: project.workspaceId,
      actor: actorId,
      action: 'project.updated',
      subjectId: projectId,
      metadata: { name: updated.name, changes: Object.keys(data) },
      patch: data,
    });
    return toSummary(updated, updated._count.documents);
  }

  /**
   * What a deletion would have to relocate, so the warning can name it before
   * anything moves.
   *
   * Derived on every request with no stored table, exactly as
   * `ProjectOverviewService` is: every number is a count over rows that already
   * exist, and a cached copy would only be a second answer to the same question.
   *
   * `target` is optional because the destination is chosen *in* the dialog: the
   * first call answers "what is in here", the second "and what does moving it
   * into that one cost" — which is the only way the glossary conflicts can be
   * known at all, since they are a property of the pair.
   */
  async deletionPreview(
    projectId: string,
    options: { target?: string; cascadeCounts: CascadeCounter },
  ): Promise<ProjectDeletionPreview> {
    const project = await this.requireProject(projectId);
    const [counts, siblings, glossaryConflicts, cascade] = await Promise.all([
      this.holdingsOf(projectId),
      this.prisma.project.count({
        where: { workspaceId: project.workspaceId, id: { not: projectId } },
      }),
      this.glossaryConflicts(projectId, options.target),
      options.cascadeCounts(projectId),
    ]);
    return {
      projectId,
      name: project.name,
      empty: isEmpty(counts),
      lastInWorkspace: siblings === 0,
      counts,
      glossaryConflicts,
      cascade,
    };
  }

  /**
   * Remove a project by moving its contents into a sibling, then deleting it.
   *
   * A cascade was never available: documents are not deletable anywhere in this
   * product (revisions are immutable, and the S3 keys, graph vertices, chunks
   * and merge requests all hang off them), so "delete the project and its
   * pages" would mean inventing a destruction path for everything downstream.
   * Moving is also the truthful operation — the pages are still wanted, it is
   * the folder that is not.
   *
   * Six tables key off a project and only two of them announce it. `documents`,
   * `glossary_terms` and `connectors` carry real FKs, so PostgreSQL refuses;
   * `workflow_definitions`, `workflow_runs` and `import_jobs` carry none and
   * would silently be left pointing at an id that no longer resolves. All six
   * move together in one transaction, or none does.
   */
  async remove(
    projectId: string,
    actorId?: string,
    options: RemoveOptions = {},
  ): Promise<DeleteProjectResponse> {
    const { moveContentsTo, cascade, confirm } = options;
    const project = await this.requireProject(projectId);

    // Checked before anything else: this one has no remedy, so offering a
    // destination for it would be offering a button that cannot work.
    const siblings = await this.prisma.project.count({
      where: { workspaceId: project.workspaceId, id: { not: projectId } },
    });
    if (siblings === 0) {
      throw new BadRequestException(t('error.project.lastInWorkspace'));
    }

    const counts = await this.holdingsOf(projectId);
    // "Empty" means holds nothing at all — not "holds no documents", which is
    // what the old check meant and why a project holding only a glossary term
    // reached PostgreSQL and came back as a 500.
    if (isEmpty(counts)) {
      // No confirmation gate here even when `cascade` was asked for: that gate
      // protects content, and there is none. Both modes do the same thing to an
      // empty project, so the answer just reports which one was asked for
      // rather than rewriting the caller's intent.
      await this.prisma.project.delete({ where: { id: projectId } });
      await this.recordDeletion(project, actorId, null, counts, []);
      return {
        deleted: true,
        mode: cascade ? 'cascade' : 'move',
        movedTo: null,
        moved: counts,
        destroyed: cascade ? ZERO_CASCADE : null,
        droppedGlossaryTerms: [],
      };
    }

    /**
     * Destroy instead of relocate.
     *
     * Gated on echoing the project's name back, checked here rather than only
     * in the dialog: this is the one call in the product that removes a page,
     * it has no undo, and a client is not where an irreversible act should be
     * confirmed. The same reason the last-project rule lives in this service
     * and not in a guard.
     */
    if (cascade) {
      if (confirm?.trim() !== project.name) {
        throw new BadRequestException(t('error.project.confirmName', { name: project.name }));
      }
      const destroyed = await cascade(projectId, project.workspaceId);
      await this.prisma.$transaction(async (tx) => {
        // Whatever the cascade does not own: the project-scoped rows that
        // outlive its documents.
        await tx.glossaryTerm.deleteMany({ where: { projectId } });
        await tx.connector.deleteMany({ where: { projectId } });
        await tx.workflowRunNode.deleteMany({ where: { run: { projectId } } });
        await tx.workflowRun.deleteMany({ where: { projectId } });
        await tx.workflowDefinition.deleteMany({ where: { projectId } });
        await tx.importJob.deleteMany({ where: { projectId } });
        await tx.notificationSubscription.deleteMany({
          where: { subjectType: 'project', subjectId: projectId },
        });
        await tx.project.delete({ where: { id: projectId } });
      });
      await this.recordDeletion(project, actorId, null, counts, [], destroyed);
      return { deleted: true, mode: 'cascade', movedTo: null, moved: ZERO_COUNTS, destroyed, droppedGlossaryTerms: [] };
    }

    if (!moveContentsTo) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.project.notEmpty'),
        reason: 'not-empty',
        // Kept beside the fuller `counts` so anything already reading it keeps working.
        documentCount: counts.documents,
        counts,
      });
    }
    if (moveContentsTo === projectId) {
      throw new BadRequestException(t('error.project.moveToSelf'));
    }
    await this.requireProjectInWorkspace(moveContentsTo, project.workspaceId);

    const droppedGlossaryTerms = await this.glossaryConflicts(projectId, moveContentsTo);

    await this.prisma.$transaction(async (tx) => {
      // glossary_terms is unique on (project_id, term), so a term both projects
      // define cannot survive the move. The destination's definition wins —
      // it is the one still in use tomorrow — and the dialog says so before the
      // press rather than leaving it to be discovered afterwards.
      if (droppedGlossaryTerms.length > 0) {
        await tx.glossaryTerm.deleteMany({
          where: { projectId, term: { in: droppedGlossaryTerms } },
        });
      }
      await tx.glossaryTerm.updateMany({ where: { projectId }, data: { projectId: moveContentsTo } });

      // No re-rooting here, unlike DocumentsService.updateDocument's single-page
      // move: the whole forest travels at once, so every parent_id still points
      // at a document inside the same project.
      await tx.document.updateMany({ where: { projectId }, data: { projectId: moveContentsTo } });

      await tx.connector.updateMany({ where: { projectId }, data: { projectId: moveContentsTo } });
      await tx.workflowDefinition.updateMany({
        where: { projectId },
        data: { projectId: moveContentsTo },
      });
      await tx.workflowRun.updateMany({ where: { projectId }, data: { projectId: moveContentsTo } });
      await tx.importJob.updateMany({ where: { projectId }, data: { projectId: moveContentsTo } });

      // The subject is going away, so its watches go with it. Watches on the
      // *documents* are untouched: those pages survive, in a new project.
      await tx.notificationSubscription.deleteMany({
        where: { subjectType: 'project', subjectId: projectId },
      });

      await tx.project.delete({ where: { id: projectId } });
    });

    await this.recordDeletion(project, actorId, moveContentsTo, counts, droppedGlossaryTerms);
    return {
      deleted: true,
      mode: 'move',
      movedTo: moveContentsTo,
      moved: counts,
      destroyed: null,
      droppedGlossaryTerms,
    };
  }

  /**
   * Everything that keys off a project, counted in one round trip.
   *
   * The three FK-bearing tables are what PostgreSQL would refuse on; the other
   * three carry no FK and would dangle instead, which is worse for being quiet.
   * Watchers neither block nor move, but losing a subscription without pressing
   * anything is worth being told about.
   */
  private async holdingsOf(projectId: string): Promise<ProjectDeletionCounts> {
    const [
      documents,
      glossaryTerms,
      connectors,
      workflowDefinitions,
      activeWorkflowRuns,
      pendingImports,
      watchers,
    ] = await Promise.all([
      this.prisma.document.count({ where: { projectId } }),
      this.prisma.glossaryTerm.count({ where: { projectId } }),
      this.prisma.connector.count({ where: { projectId } }),
      this.prisma.workflowDefinition.count({ where: { projectId } }),
      this.prisma.workflowRun.count({
        where: { projectId, status: { in: ['pending', 'running', 'awaiting-review', 'paused'] } },
      }),
      this.prisma.importJob.count({
        where: { projectId, status: { in: ['awaiting-upload', 'queued', 'running'] } },
      }),
      this.prisma.notificationSubscription.count({
        where: { subjectType: 'project', subjectId: projectId, muted: false },
      }),
    ]);
    return {
      documents,
      glossaryTerms,
      connectors,
      workflowDefinitions,
      activeWorkflowRuns,
      pendingImports,
      watchers,
    };
  }

  /** Terms both projects define. A property of the pair, so it needs the target. */
  private async glossaryConflicts(projectId: string, target?: string): Promise<string[]> {
    if (!target || target === projectId) return [];
    const source = await this.prisma.glossaryTerm.findMany({
      where: { projectId },
      select: { term: true },
    });
    if (source.length === 0) return [];
    const clashes = await this.prisma.glossaryTerm.findMany({
      where: { projectId: target, term: { in: source.map((r) => r.term) } },
      select: { term: true },
    });
    return clashes.map((r) => r.term).sort();
  }

  private async recordDeletion(
    project: Project,
    actorId: string | undefined,
    movedTo: string | null,
    moved: ProjectDeletionCounts,
    droppedGlossaryTerms: string[],
    destroyed?: ProjectCascadeCounts,
  ): Promise<void> {
    await this.activity.record({
      workspaceId: project.workspaceId,
      actor: actorId,
      action: 'project.deleted',
      subjectId: project.id,
      // Where things went belongs in the feed: without it the entry reads as a
      // destruction, and the pages it names are still there under another
      // project. activity_log rows *inside* the project deliberately keep
      // pointing at it — rewriting them to claim those events happened in the
      // destination would be inventing history.
      metadata: { name: project.name, movedTo, moved, droppedGlossaryTerms, destroyed: destroyed ?? null },
    });
  }

  /**
   * Shared guard for the documents module: a document's project must exist and
   * live in the same workspace, otherwise a project id from another tenant
   * would silently re-parent the page.
   */
  async requireProjectInWorkspace(projectId: string, workspaceId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== workspaceId) {
      throw new BadRequestException(t('error.project.notInWorkspace', { id: projectId }));
    }
    return project;
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    return project;
  }
}

function toSummary(project: Project, documentCount: number): ProjectSummary {
  return {
    projectId: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    description: project.description,
    avatarUrl: projectAvatarUrl(project),
    avatarEmoji: project.avatarEmoji,
    avatarColor: project.avatarColor,
    documentCount,
    createdAt: project.createdAt.toISOString(),
  };
}

/**
 * Holds nothing at all.
 *
 * Spelled as "every count is zero" rather than a list of the ones that matter,
 * so a table added to `ProjectDeletionCounts` later cannot quietly stop being
 * checked — a new field defaults to blocking, which is the safe direction.
 */
function isEmpty(counts: ProjectDeletionCounts): boolean {
  return Object.values(counts).every((n) => n === 0);
}
