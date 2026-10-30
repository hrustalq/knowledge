import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_API_BREAKING_CHANGE_POLICY, isApiSpecKind } from '@knowledge/contracts';
import type {
  ApiBreakingAck,
  ApiBreakingChangePolicy,
  ApiSpecDiff,
  CreateMergeRequestResponse,
  ListMergeRequestsResponse,
  ListProjectBranchesResponse,
  ListWorkspaceMergeRequestsRequest,
  ListWorkspaceMergeRequestsResponse,
  MergeConflictHunk,
  MergeMergeRequestResponse,
  MergeRequestApiChangesResponse,
  MergeRequestCheckInfo,
  MergeRequestConflictsResponse,
  MergeRequestDiffResponse,
  MergeRequestInfo,
  MergeRequestProvenance,
  MergeRequestStatus,
  MergeStrategy,
  PublishBranchResponse,
  UpdateMergeRequestBranchResponse,
} from '@knowledge/contracts';
import type { DocumentBranch, MergeRequest, MergeRequestReviewer } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRevisionInfo } from './revision-info.js';
import { StorageService } from '../storage/storage.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AccessService } from '../auth/access.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { WORKSPACE_READER, type Principal } from '../auth/principal.js';
import { DOCUMENT_ARCHIVED, DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import type {
  CreateMergeRequestDto,
  PublishBranchDto,
  UpdateMergeRequestBranchDto,
  UpdateMergeRequestDto,
} from './dto/merge-requests.dto.js';
import { t } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { ApiSpecDiffService } from '../api-specs/api-spec-diff.service.js';
import { EntitiesService } from '../entities/entities.service.js';
import { AuditService } from '../auth/audit.service.js';
import { ConflictsService } from '../conflicts/conflicts.service.js';
import { LintChecksService } from './lint/lint-checks.service.js';
import { lintGateEnforced, overridable } from './lint/lint-check.js';
import { ProjectCommitsService, type PagePlace } from '../git/project-commits.service.js';
import { sourcePages } from './mr-pages.js';
import { hasConflictMarkers, threeWay, type ThreeWayResult } from './three-way.js';

/** Fallback author when no principal is supplied (AUTH_MODE=none, MCP stdio). */
export const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

const MR_INCLUDE = { sourceBranch: true, targetBranch: true, reviewers: true } as const;

type MrWithBranches = MergeRequest & {
  sourceBranch: DocumentBranch;
  targetBranch: DocumentBranch;
  reviewers: MergeRequestReviewer[];
};

/** One page a source branch changes against a target (#636). */
interface MrPage {
  documentId: string;
  source: DocumentBranch & { headRevisionId: string };
  target: DocumentBranch;
  /** Null when the target has no head yet: a page's first merge request. */
  mergeBase: string | null;
}

/** A page body and its content type. */
interface Body {
  text: string;
  contentType: string;
}

/** The branch names git's conflict markers are labelled with. */
type MergeLabels = { target: string; source: string };

/** A page branch that holds a revision of its own: the branch wrote that page. */
const WROTE = { revisions: { some: { status: { not: 'draft' } } } } as const;

/**
 * Merge requests whose branch changed the page (#636): the ones opened from it,
 * and the ones whose project branch wrote it from another page.
 */
const touchesPage = (documentId: string) => ({
  OR: [{ documentId }, { sourceBranch: { projectBranch: { branches: { some: { documentId, ...WROTE } } } } }],
});

/** The target moved past the merge base: a fast-forward no longer lands it. */
const behind = (p: MrPage): boolean => p.target.headRevisionId !== null && p.mergeBase !== p.target.headRevisionId;

/**
 * GitLab-style merge requests over the revision DAG (plan.md §8).
 *
 * A merge request spans every page its source branch changed (#636): a branch
 * is its project's, so `sourcePages` derives the set and `documentId` is only
 * the page it was opened from. Every gate runs across the set, and the merge
 * lands every page in one transaction or none.
 *
 * Merging is a 3-way merge per page (#636, `three-way.ts`): a page whose
 * target still sits at its merge base lands the source head's body, as a
 * fast-forward would, and one whose target moved lands the line merge of both
 * sides. Overlapping hunks refuse with `conflict`, which "Update branch"
 * (`updateBranch`) resolves by merging the target into the source — history is
 * append-only, so nothing is rebased. Strategies:
 * - merge-commit → new revision with parents [targetHead, sourceHead]
 * - squash      → new revision parented only on targetHead
 * Either way the merge revision goes through the normal finalize → outbox →
 * reindex pipeline.
 *
 * Merge gating: draft MRs never merge; MR_REQUIRED_APPROVALS non-author
 * approvals are required (0 disables); merging into a protected branch
 * requires the workspace admin role; a page whose style lint is `block` waits
 * for the check of its source head and for its error-severity violations to
 * be resolved, or for an admin's override (#74); a spec whose source head
 * breaks its API waits for an admin's acknowledgement under a `block` policy
 * (#78).
 */
@Injectable()
export class MergeRequestsService {
  private readonly logger = new Logger(MergeRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
    private readonly compare: CompareService,
    private readonly activity: ActivityService,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    // See DocumentThreadsService: NotificationsService cannot publish, so the
    // frames for `assigned` and `review-requested` are announced from here.
    private readonly events: EventsPublisher,
    private readonly permissions: PermissionService,
    private readonly apiDiffs: ApiSpecDiffService,
    private readonly entities: EntitiesService,
    private readonly lint: LintChecksService,
    private readonly audit: AuditService,
    private readonly conflicts: ConflictsService,
    private readonly commits: ProjectCommitsService,
  ) {}

  /**
   * `opts.provenance` says who opened it when that is not a person (issue
   * #73): an agent's finding, or an agent-session capture with its row id. An
   * argument, not a DTO field — no REST caller may claim to be an agent.
   */
  async create(
    documentId: string,
    dto: CreateMergeRequestDto,
    authorId: string = AUTHOR_ID_STUB,
    opts: { provenance?: MergeRequestProvenance; captureId?: string } = {},
  ): Promise<CreateMergeRequestResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    // An archived page is read-only until unarchived (docs/features/39): the
    // same 409 DocumentsService raises for a revision, so a client has one
    // reason to branch on.
    if (document.archivedAt) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.document.archived', { id: documentId }),
        reason: DOCUMENT_ARCHIVED,
      });
    }

    const targetName = dto.targetBranch ?? document.defaultBranch;
    if (dto.sourceBranch === targetName) {
      throw new BadRequestException(t('error.mergeRequest.sameBranches'));
    }

    const [source, target] = await Promise.all([
      this.getBranchOrThrow(documentId, dto.sourceBranch),
      this.getBranchOrThrow(documentId, targetName),
    ]);
    if (!source.headRevisionId) {
      throw new BadRequestException(t('error.mergeRequest.sourceNotFinalized', { branch: source.name }));
    }

    await this.rejectDuplicateOpen(source, target);
    this.assertTargetsExist(await this.changedPages(source, target.name), target.name);

    const mr = await this.prisma.mergeRequest.create({
      data: {
        documentId,
        sourceBranchId: source.id,
        targetBranchId: target.id,
        title: dto.title,
        description: dto.description ?? null,
        authorId,
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
        ...(opts.captureId ? { captureId: opts.captureId } : {}),
      },
      include: MR_INCLUDE,
    });
    // A merge request is read by everyone who can read the page, so a private
    // branch it names stops being private (#474), on every page it spans
    // (#636). Only someone who may edit that branch got this far (the guard
    // holds `sourceBranch` and `targetBranch`).
    await this.prisma.documentBranch.updateMany({
      where: {
        OR: [{ id: { in: [source.id, target.id] } }, ...(source.projectBranchId ? [{ projectBranchId: source.projectBranchId }] : [])],
        restricted: true,
      },
      data: { restricted: false },
    });
    const page = await this.recordActivity(mr.documentId, 'merge-request.created', mr.id, authorId, {
      title: dto.title,
      sourceBranch: source.name,
      targetBranch: target.name,
    });
    // Opening a merge request is watching it. Recorded as a subscription rather
    // than inferred from `authorId` at fan-out time so that unwatching your own
    // merge request actually works.
    if (page) {
      await this.notifications.ensureSubscription(
        page.workspaceId,
        authorId,
        'merge-request',
        mr.id,
        'author',
      );
    }
    return { mergeRequest: await this.toDetail(mr) };
  }

  /**
   * Every merge request whose branch changed the page (#636). One opened from a
   * page `scope` may not open is left out, as in the workspace list: a merge
   * request is read through the page it was opened from.
   */
  async list(documentId: string, scope: AccessScope): Promise<ListMergeRequestsResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));

    const rows = await this.prisma.mergeRequest.findMany({
      where: { ...touchesPage(documentId), document: { AND: [visibilityWhere(scope)] } },
      include: MR_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    // No merge base on list rows — it costs a graph BFS per MR (contracts doc it as null).
    const [stats, pages] = await Promise.all([this.statsFor(rows.map((r) => r.id)), this.pagesFor(rows)]);
    return { documentId, mergeRequests: rows.map((mr) => this.toInfo(mr, null, stats.get(mr.id), pages.get(mr.id))) };
  }

  async listWorkspace(
    query: ListWorkspaceMergeRequestsRequest,
    scope: AccessScope,
  ): Promise<ListWorkspaceMergeRequestsResponse> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    // Everything except the status filter — the per-status counts (tab badges)
    // apply the same search/people/branch/document scope.
    //
    // Branches are a relation, not a column: the name lives on DocumentBranch,
    // and it is matched as a case-insensitive substring so "auth" finds
    // "feature/auth" (typing a branch name in full, exactly, is not a filter).
    //
    // A merge request is its page: one on a page the caller may not open is
    // not in the list, nor in the tab counts (#76).
    const baseWhere = {
      // A branch is one project's (#636), so the page it was opened from names it.
      document: { workspaceId: query.workspaceId, ...(query.projectId ? { projectId: query.projectId } : {}), AND: [visibilityWhere(scope)] },
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
      ...(query.documentId ? touchesPage(query.documentId) : {}),
      ...(query.reviewerId ? { reviewers: { some: { userId: query.reviewerId } } } : {}),
      ...(query.sourceBranch
        ? { sourceBranch: { name: { contains: query.sourceBranch, mode: 'insensitive' as const } } }
        : {}),
      ...(query.targetBranch
        ? { targetBranch: { name: { contains: query.targetBranch, mode: 'insensitive' as const } } }
        : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...(query.provenance ? { provenance: query.provenance } : {}),
    };
    const [rows, statusCounts] = await Promise.all([
      this.prisma.mergeRequest.findMany({
        where: { ...baseWhere, ...(query.status ? { status: query.status } : {}) },
        include: MR_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.prisma.mergeRequest.groupBy({ by: ['status'], where: baseWhere, _count: { _all: true } }),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const [stats, pages] = await Promise.all([this.statsFor(page.map((r) => r.id)), this.pagesFor(page)]);
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const row of statusCounts) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row._count._all;
    }
    return {
      workspaceId: query.workspaceId,
      mergeRequests: page.map((mr) => this.toInfo(mr, null, stats.get(mr.id), pages.get(mr.id))),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
      counts,
    };
  }

  async get(mergeRequestId: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    return { mergeRequest: await this.toDetail(mr) };
  }

  /** Title/description/draft-flag edits — open merge requests only. */
  async update(
    mergeRequestId: string,
    dto: UpdateMergeRequestDto,
    actorId?: string,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForEdit', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const changed = (['title', 'description', 'isDraft', 'assigneeId'] as const).filter(
      (k) => dto[k] !== undefined && dto[k] !== mr[k],
    );
    if (changed.length === 0) return { mergeRequest: await this.toDetail(mr) };

    if (dto.assigneeId != null && dto.assigneeId !== mr.assigneeId) {
      await this.assertWorkspaceMembers(mr.documentId, [dto.assigneeId]);
    }
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.isDraft !== undefined ? { isDraft: dto.isDraft } : {}),
        ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
      },
      include: MR_INCLUDE,
    });
    const page = await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, actorId, {
      title: updated.title,
      changed,
      // The activity timeline renders draft and assignee edits as their own
      // system notes ("marked as ready", "assigned to X"), which needs the
      // value that was set and not just the name of the field.
      ...(changed.includes('isDraft') ? { isDraft: updated.isDraft } : {}),
      ...(changed.includes('assigneeId') ? { assigneeId: updated.assigneeId } : {}),
    });
    // Being handed a merge request is addressed to one person, so it is told
    // directly rather than left to the subject's watchers: `merge-request.updated`
    // is not notifiable at all (a title edit is not news), and an assignee who
    // never watched the MR would otherwise hear nothing.
    if (page && updated.assigneeId && changed.includes('assigneeId')) {
      const delivered = await this.notifications.notify({
        workspaceId: page.workspaceId,
        userIds: [updated.assigneeId],
        // The event that actually happened. It is not notifiable on its own —
        // `notificationRowCategory` files this row under `review` from the
        // reason instead.
        type: 'merge-request.updated',
        reason: 'assigned',
        actor: actorId ?? null,
        documentId: mr.documentId,
        subjectType: 'merge-request',
        subjectId: mr.id,
        title: updated.title,
        metadata: { assigned: true },
        subscribe: true,
      });
      await this.events.announce(page.workspaceId, delivered);
    }
    return { mergeRequest: await this.toDetail(updated) };
  }

  /** closed → open. Merged MRs are terminal. */
  async reopen(mergeRequestId: string, actorId?: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'closed') {
      throw new BadRequestException(t('error.mergeRequest.notClosedForReopen', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    await this.rejectDuplicateOpen(mr.sourceBranch, mr.targetBranch);

    // Guarded flip: a concurrent reopen (or delete) makes count 0.
    const flipped = await this.prisma.mergeRequest.updateMany({
      where: { id: mr.id, status: 'closed' },
      data: { status: 'open', closedAt: null },
    });
    if (flipped.count === 0) {
      throw new ConflictException(t('error.mergeRequest.concurrentChange', { id: mr.id }));
    }
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    await this.recordActivity(mr.documentId, 'merge-request.reopened', mr.id, actorId, { title: mr.title });
    return { mergeRequest: await this.toDetail(updated) };
  }

  /** Replace-set reviewer assignment. Reviewers must be members of the document's workspace. */
  async setReviewers(
    mergeRequestId: string,
    reviewerIds: string[],
    actorId?: string,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForReviewers', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const wanted = [...new Set(reviewerIds)];
    await this.assertWorkspaceMembers(mr.documentId, wanted);

    const current = new Set(mr.reviewers.map((r) => r.userId));
    const added = wanted.filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.includes(id));
    if (added.length > 0 || removed.length > 0) {
      await this.prisma.$transaction([
        this.prisma.mergeRequestReviewer.deleteMany({
          where: { mergeRequestId: mr.id, userId: { in: removed } },
        }),
        this.prisma.mergeRequestReviewer.createMany({
          data: added.map((userId) => ({ mergeRequestId: mr.id, userId, addedBy: actorId ?? null })),
        }),
      ]);
    }
    if (added.length > 0) {
      const page = await this.recordActivity(
        mr.documentId,
        'merge-request.review-requested',
        mr.id,
        actorId,
        { title: mr.title, reviewerIds: added },
      );
      // Directed for the same reason as the assignee above: the reviewer ids
      // live in the activity metadata, which never reaches the event bus, so
      // the fan-out could not find these people even in principle.
      if (page) {
        const delivered = await this.notifications.notify({
          workspaceId: page.workspaceId,
          userIds: added,
          type: 'merge-request.review-requested',
          reason: 'review-requested',
          actor: actorId ?? null,
          documentId: mr.documentId,
          subjectType: 'merge-request',
          subjectId: mr.id,
          title: mr.title,
          subscribe: true,
        });
        await this.events.announce(page.workspaceId, delivered);
      }
    }
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    return { mergeRequest: await this.toDetail(updated) };
  }

  /**
   * Merge-base comparison targetHead...sourceHead with structural + (optional)
   * semantic sections, for the page it was opened from and for every changed
   * page `scope` may open (#636).
   */
  async diff(mergeRequestId: string, scope: AccessScope, opts: { semantic?: boolean } = {}): Promise<MergeRequestDiffResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const sourceHead = mr.sourceBranch.headRevisionId;
    if (!sourceHead) throw new BadRequestException(t('error.mergeRequest.branchNoRevisions', { branch: mr.sourceBranch.name }));

    // A page's first merge request (a capture, a chat save) has nothing on the
    // target yet: the whole source is the change (#73).
    const options = { structural: true, semantic: opts.semantic ?? false };
    const compareOf = (documentId: string, target: string | null, source: string) =>
      target
        ? this.compare.compare(documentId, target, source, 'merge-base', options)
        : this.compare.compareWithNothing(documentId, source, options);
    const changed = await this.changedPages(mr.sourceBranch, mr.targetBranch.name);
    const visible = await this.permissions.visibleDocumentIds(scope, changed.map((p) => p.documentId));
    const shown = changed.filter((p) => visible.has(p.documentId));
    const titles = new Map(
      (await this.prisma.document.findMany({ where: { id: { in: shown.map((p) => p.documentId) } }, select: { id: true, title: true } })).map(
        (d) => [d.id, d.title],
      ),
    );
    const pages = await Promise.all(
      shown.map(async (p) => ({
        documentId: p.documentId,
        title: titles.get(p.documentId) ?? '',
        compare: await compareOf(p.documentId, p.target.headRevisionId, p.source.headRevisionId),
      })),
    );
    const compare =
      pages.find((p) => p.documentId === mr.documentId)?.compare ??
      (await compareOf(mr.documentId, mr.targetBranch.headRevisionId, sourceHead));
    return { mergeRequest: await this.toDetail(mr), compare, pages, hiddenPages: changed.length - shown.length };
  }

  /**
   * The pages `source` changes against `targetName`, the page it was opened
   * from first (#636). A page whose source head the target already holds is
   * left out, and so is one with no branch called `targetName` — the caller
   * that lands pages refuses those (`assertTargetsExist`).
   */
  private async changedPages(source: DocumentBranch, targetName: string): Promise<MrPage[] & { missing: string[] }> {
    const branches = (await sourcePages(this.prisma, source)).filter(
      (b): b is MrPage['source'] => b.headRevisionId !== null,
    );
    const targets = await this.prisma.documentBranch.findMany({
      where: { documentId: { in: branches.map((b) => b.documentId) }, name: targetName },
    });
    const byPage = new Map(targets.map((b) => [b.documentId, b]));
    const pages = await Promise.all(
      branches
        .filter((b) => byPage.has(b.documentId))
        .map(async (b): Promise<MrPage> => {
          const target = byPage.get(b.documentId)!;
          const mergeBase = target.headRevisionId
            ? await this.compare.findMergeBase(b.documentId, target.headRevisionId, b.headRevisionId)
            : null;
          return { documentId: b.documentId, source: b, target, mergeBase };
        }),
    );
    return Object.assign(
      pages.filter((p) => p.mergeBase !== p.source.headRevisionId),
      { missing: branches.filter((b) => !byPage.has(b.documentId)).map((b) => b.documentId) },
    );
  }

  /** 400 when a changed page has no branch to land on. Ids, never titles: the caller may not see the page. */
  private assertTargetsExist(pages: { missing: string[] }, targetName: string): void {
    if (pages.missing.length === 0) return;
    throw new BadRequestException(
      t('error.mergeRequest.targetMissing', { branch: targetName, pages: pages.missing.join(', ') }),
    );
  }

  /**
   * What a spec merge request does to its API (#78, phase 6): the classified
   * diff from the merge base to the source head, the pages linking each
   * changed operation as the caller may see them, and whether the gate would
   * refuse a merge now. It describes the first changed spec page the caller
   * may open (#636), while `blocked` answers for every spec page in the merge
   * request, as the gate does. One with no spec page answers
   * `applicable: false`, so the merge-request page can ask without knowing.
   */
  async apiChanges(mergeRequestId: string, scope: AccessScope): Promise<MergeRequestApiChangesResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const state = await this.breakingState(mr, await this.changedPages(mr.sourceBranch, mr.targetBranch.name));
    const visible = await this.permissions.visibleDocumentIds(scope, state.specs.map((s) => s.documentId));
    const shown = state.specs.find((s) => visible.has(s.documentId));
    if (!shown) {
      return {
        mergeRequestId: mr.id,
        documentId: mr.documentId,
        applicable: false,
        policy: DEFAULT_API_BREAKING_CHANGE_POLICY,
        diff: null,
        affectedPages: {},
        ack: null,
        blocked: false,
      };
    }
    const keys = [...new Set((shown.diff?.changes ?? []).map((c) => c.entityKey))].slice(0, 200);
    const pages = await this.entities.inboundPages(scope, keys);
    const affectedPages: MergeRequestApiChangesResponse['affectedPages'] = {};
    for (const key of keys) {
      const list = (pages.get(key) ?? []).filter((p) => p.documentId !== shown.documentId);
      if (list.length) affectedPages[key] = list;
    }
    return {
      mergeRequestId: mr.id,
      documentId: shown.documentId,
      applicable: true,
      policy: state.policy,
      diff: shown.diff,
      affectedPages,
      ack: this.breakingAckOf(mr, state.headCommit),
      blocked: state.blocking !== null,
    };
  }

  /**
   * An admin acknowledges (or withdraws) the breaking changes at the source
   * branch's current head commit (#636). Pinned to it: a later write to any
   * page of the branch is a change nobody has read yet, so the gate closes
   * again until it is acknowledged in turn.
   */
  async setBreakingAck(
    mergeRequestId: string,
    acknowledged: boolean,
    scope: AccessScope,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<MergeRequestApiChangesResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForAck', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const state = await this.breakingState(mr, await this.changedPages(mr.sourceBranch, mr.targetBranch.name));
    const spec = state.specs[0];
    if (!spec) throw new BadRequestException(t('error.mergeRequest.notSpec', { id: mr.id }));

    // `breakingAckRevisionId` is what the previous image reads; this one reads the commit.
    await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: acknowledged
        ? { breakingAckBy: actorId, breakingAckAt: new Date(), breakingAckRevisionId: spec.sourceHeadId, breakingAckCommitId: state.headCommit }
        : { breakingAckBy: null, breakingAckAt: null, breakingAckRevisionId: null, breakingAckCommitId: null },
    });
    await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, actorId, {
      title: mr.title,
      changed: ['breakingAck'],
      breakingAck: acknowledged,
      ...(acknowledged ? { revisionId: spec.sourceHeadId } : {}),
    });
    return this.apiChanges(mr.id, scope);
  }

  /**
   * Each changed spec page's diff from its merge base (or nothing, for a first
   * merge) to its source head, the policy, the source branch's head commit,
   * and the first spec page that would hold a merge — the one predicate the
   * panel and the gate share.
   */
  private async breakingState(
    mr: MrWithBranches,
    pages: MrPage[],
  ): Promise<{
    policy: ApiBreakingChangePolicy;
    headCommit: string | null;
    specs: { documentId: string; sourceHeadId: string; diff: ApiSpecDiff | null }[];
    blocking: { documentId: string; breaking: number } | null;
  }> {
    const docs = await this.prisma.document.findMany({
      where: { id: { in: pages.map((p) => p.documentId) } },
      select: { id: true, kind: true, workspaceId: true, projectId: true },
    });
    const specIds = new Set(docs.filter((d) => isApiSpecKind(d.kind)).map((d) => d.id));
    const specPages = pages.filter((p) => specIds.has(p.documentId));
    if (specPages.length === 0) return { policy: DEFAULT_API_BREAKING_CHANGE_POLICY, headCommit: null, specs: [], blocking: null };
    const [policy, headCommit, specs] = await Promise.all([
      this.apiDiffs.breakingPolicy(docs[0].workspaceId),
      this.commits.headCommit(docs[0].projectId, mr.sourceBranch.name),
      Promise.all(
        specPages.map(async (p) => {
          const base = p.target.headRevisionId ? (p.mergeBase ?? p.target.headRevisionId) : null;
          const diff = await this.apiDiffs.diff(p.documentId, base, p.source.headRevisionId);
          return { documentId: p.documentId, sourceHeadId: p.source.headRevisionId, diff };
        }),
      ),
    ]);
    const acked = this.breakingAckOf(mr, headCommit)?.current ?? false;
    const hit = policy === 'block' && !acked ? specs.find((s) => (s.diff?.summary.breaking ?? 0) > 0) : undefined;
    return { policy, headCommit, specs, blocking: hit ? { documentId: hit.documentId, breaking: hit.diff!.summary.breaking } : null };
  }

  private breakingAckOf(mr: MergeRequest, headCommit: string | null): ApiBreakingAck | null {
    if (!mr.breakingAckBy || !mr.breakingAckRevisionId) return null;
    return {
      by: mr.breakingAckBy,
      at: (mr.breakingAckAt ?? mr.createdAt).toISOString(),
      revisionId: mr.breakingAckRevisionId,
      current: mr.breakingAckCommitId !== null && mr.breakingAckCommitId === headCommit,
    };
  }

  /**
   * An admin lets the current source head merge despite its style check
   * (#74): one still to come, or one with violations left open. Bound to that
   * head — a later push is linted afresh and needs its own pass or override.
   * Audited, and in the activity feed with its reason.
   */
  async overrideLintCheck(
    mergeRequestId: string,
    checkId: string,
    reason: string,
    principal?: Principal,
  ): Promise<{ check: MergeRequestCheckInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') throw new BadRequestException(t('error.lint.notOpen'));
    const check = await this.prisma.mergeRequestCheck.findFirst({ where: { id: checkId, mergeRequestId: mr.id, kind: 'lint' } });
    if (!check) throw new NotFoundException(t('error.lint.checkNotFound', { id: checkId }));
    // Current = still the head of its page's source branch (#636: one check per page).
    const heads = (await sourcePages(this.prisma, mr.sourceBranch)).map((b) => b.headRevisionId);
    if (!heads.includes(check.headRevisionId)) {
      throw new ConflictException({ statusCode: 409, message: t('error.lint.overrideNotCurrent'), reason: 'lint.notCurrent' });
    }
    if (!overridable(check.status as MergeRequestCheckInfo['status'])) {
      throw new ConflictException({ statusCode: 409, message: t('error.lint.notOverridable'), reason: 'lint.notOverridable' });
    }

    const actorId = principal?.userId ?? AUTHOR_ID_STUB;
    // Guarded: two admins pressing together write one override, and a check
    // that settled to `passed` meanwhile has nothing left to override.
    const claimed = await this.prisma.mergeRequestCheck.updateMany({
      where: { id: check.id, overriddenAt: null, status: { in: ['pending', 'failed'] } },
      data: { overriddenBy: actorId, overriddenAt: new Date(), overrideReason: reason },
    });
    if (claimed.count === 0) {
      throw new ConflictException({ statusCode: 409, message: t('error.lint.alreadyOverridden'), reason: 'lint.alreadyOverridden' });
    }

    const params = { mergeRequestId: mr.id, checkId: check.id, headRevisionId: check.headRevisionId, reason };
    await this.audit.record({
      workspaceId: check.workspaceId,
      actor: principal?.userId ?? 'dev',
      action: 'merge-request.lint-override',
      params,
      ok: true,
    });
    await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, actorId, {
      title: mr.title,
      changed: ['lintOverride'],
      lintOverride: { checkId: check.id, reason },
      revisionId: check.headRevisionId,
    });
    const { checks } = await this.lint.list(mr.id, lintGateEnforced(principal));
    return { check: checks.find((c) => c.checkId === check.id)! };
  }

  /** The page a merge request is on — for a caller that needs its workspace first. */
  async documentOf(mergeRequestId: string): Promise<{ documentId: string }> {
    const mr = await this.prisma.mergeRequest.findUnique({ where: { id: mergeRequestId }, select: { documentId: true } });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    return mr;
  }

  /** Records approval by the calling principal; merge requires MR_REQUIRED_APPROVALS of these (author's own excluded). */
  async approve(
    mergeRequestId: string,
    approverId: string = AUTHOR_ID_STUB,
  ): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForApproval', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const approved = [...new Set([...this.approvers(mr), approverId])];
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { approvedBy: approved },
      include: MR_INCLUDE,
    });
    await this.recordActivity(mr.documentId, 'merge-request.approved', mr.id, approverId, { title: mr.title });
    return { mergeRequest: await this.toDetail(updated) };
  }

  async close(mergeRequestId: string, actorId?: string): Promise<{ mergeRequest: MergeRequestInfo }> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForClose', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const updated = await this.prisma.mergeRequest.update({
      where: { id: mr.id },
      data: { status: 'closed', closedAt: new Date() },
      include: MR_INCLUDE,
    });
    await this.recordActivity(mr.documentId, 'merge-request.closed', mr.id, actorId, { title: mr.title });
    return { mergeRequest: await this.toDetail(updated) };
  }

  /**
   * `opts.onTopOf` (#474, `publishBranch` only): the target heads the author
   * reviewed after they moved past the source, one per page (#636). A page
   * whose 3-way merge conflicts lands over its listed head instead of refusing
   * — the source's content wins, as it does for a shared draft's "Publish on
   * top" — and over no other head.
   */
  async merge(
    mergeRequestId: string,
    strategy: MergeStrategy = 'merge-commit',
    principal?: Principal,
    opts: { onTopOf?: readonly string[] } = {},
  ): Promise<MergeMergeRequestResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const { pages, places, projectId } = await this.gates(mr, principal);

    // What every page lands with (#636), where the fast-forward precondition
    // stood: only overlapping hunks refuse now, before anything is staged.
    const bodies = await this.mergedBodies(pages, { target: mr.targetBranch.name, source: mr.sourceBranch.name }, opts.onTopOf);
    await this.breakingGate(mr, pages);

    const message =
      strategy === 'squash'
        ? `${mr.title} (squashed from ${mr.sourceBranch.name})`
        : `Merge branch '${mr.sourceBranch.name}' into '${mr.targetBranch.name}'`;

    // Every page's body is staged before the transaction opens (#636): a draft
    // revision on the target, parented on the head the checks above read, with
    // the merged bytes. The transaction then only locks, re-checks and
    // finalizes, so its length grows with the page count by finalize's own two
    // S3 reads per page, not by the four a merge used to make inside it.
    const drafts: string[] = [];
    const staged: { documentId: string; revisionId: string; targetBranchId: string; targetHeadId: string | null }[] = [];
    let finalized: Awaited<ReturnType<DocumentsService['finalizeRevision']>> | null;
    try {
      for (const p of pages) {
        // Second parent = source head → a true merge node in the revision DAG (plan.md §4).
        const second = strategy === 'merge-commit' ? { id: p.source.headRevisionId, order: p.target.headRevisionId ? 2 : 1 } : null;
        const revisionId = await this.stage(drafts, p.documentId, p.target.name, message, bodies.get(p.documentId)!, second);
        staged.push({ documentId: p.documentId, revisionId, targetBranchId: p.target.id, targetHeadId: p.target.headRevisionId });
      }

      // The merge revisions and the MR's own status commit together. They did
      // not, and the gap left the worst possible pair of facts: the target
      // branch advanced, so the MR was no longer mergeable, while its status
      // was still `open` — permanently, with no route back. Every page lands,
      // or none does.
      finalized = await this.prisma.withTransaction(
        async () => {
          // The project's commit lock (#636) comes before the branch-row locks:
          // finalizeRevision takes it first too, so the order is the same for
          // every writer and a merge never deadlocks against a plain save.
          await this.commits.lock(projectId);
          // The branch-row locks. The heads the merge above was computed on are
          // an unlocked read: under READ COMMITTED it sees the last committed head
          // and NOT a concurrent merge's uncommitted advance, so two mergers
          // could both pass it and the second would then commit over the
          // first's head. Taken in id order, so two merges sharing pages
          // serialize rather than deadlock.
          const headNow = await this.lockHeads(staged.map((x) => x.targetBranchId));
          for (const x of staged) {
            const now = headNow.get(x.targetBranchId) ?? null;
            if (now === x.targetHeadId) continue;
            const sourceHeadId = pages.find((p) => p.documentId === x.documentId)!.source.headRevisionId;
            throw new ConflictException({
              statusCode: 409,
              message: t('error.mergeRequest.divergedWhileMerging', { target: mr.targetBranch.name }),
              reason: 'diverged',
              documentId: x.documentId,
              currentHeadRevisionId: now,
              sourceHeadRevisionId: sourceHeadId,
              comparisonUrl: `/v1/documents/${x.documentId}/compare?from=${now}&to=${sourceHeadId}&mode=merge-base`,
            });
          }

          // Normal pipeline per page: hash → (branch-scoped) dedupe → branch
          // head advance → outbox → reindex. One project commit for them all,
          // the merger's; a merge commit's second parent is the source
          // branch's head commit, and a squash has one parent, as in git.
          const results: (Awaited<ReturnType<DocumentsService['finalizeRevision']>> & { documentId: string })[] = [];
          for (const x of staged) {
            results.push({ documentId: x.documentId, ...(await this.documents.finalizeRevision(x.documentId, x.revisionId, { commit: false })) });
          }
          // The branch's moves, renames and archives land with its content (#636 phase 4).
          const placed = await this.documents.applyPlaces(projectId, places, principal?.userId ?? AUTHOR_ID_STUB);
          const mergedFrom = strategy === 'merge-commit' ? mr.sourceBranch.name : undefined;
          const revisionIds = results.filter((r) => !r.deduplicated).map((r) => r.revisionId);
          if (revisionIds.length) await this.commits.recordRevisions(revisionIds, { authorId: principal?.userId, mergedFrom, placed });
          else await this.commits.recordState(projectId, placed, { actorId: principal?.userId, message, mergedFrom });
          const result = results.find((r) => r.documentId === mr.documentId) ?? results[0] ?? null;
          await this.flipMerged(mr, strategy, result?.revisionId ?? null, [...pages.map((p) => p.documentId), ...places.map((p) => p.documentId)]);
          return result;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (e) {
      await this.dropDrafts(drafts);
      throw e;
    }
    return this.afterMerge(mr, strategy, finalized?.revisionId ?? null, principal, pages.length);
  }

  /**
   * Merge by pushing a local merge commit (#636 phase 4): every gate a web
   * merge passes, then `land` writes the pushed commit — its revisions on the
   * target and its tree — inside the transaction that flips the merge request.
   * `land` returns the merged revision on the merge request's own page, if
   * the push changed it.
   */
  async mergeByPush(mergeRequestId: string, principal: Principal, land: () => Promise<string | null>): Promise<MergeRequestInfo> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const { pages, places, projectId } = await this.gates(mr, principal);
    await this.breakingGate(mr, pages);
    const revisionId = await this.prisma.withTransaction(
      async () => {
        await this.commits.lock(projectId);
        const landed = await land();
        await this.flipMerged(mr, 'merge-commit', landed, [...pages.map((p) => p.documentId), ...places.map((p) => p.documentId)]);
        return landed;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return (await this.afterMerge(mr, 'merge-commit', revisionId, principal, pages.length)).mergeRequest;
  }

  /** Guarded status flip, and the pages that existed only as this merge request join the tree (#73). */
  private async flipMerged(mr: MrWithBranches, strategy: MergeStrategy, mergedRevisionId: string | null, documentIds: string[]): Promise<void> {
    // A concurrent merge/close of THIS MR loses the race and 409s, rolling its revisions back.
    const flipped = await this.prisma.mergeRequest.updateMany({
      where: { id: mr.id, status: 'open' },
      data: { status: 'merged', strategy, mergedRevisionId, mergedAt: new Date() },
    });
    if (flipped.count === 0) {
      throw new ConflictException(t('error.mergeRequest.concurrentChange', { id: mr.id }));
    }
    await this.prisma.document.updateMany({
      where: { id: { in: documentIds }, pendingMergeRequestId: mr.id },
      data: { pendingMergeRequestId: null },
    });
  }

  private async afterMerge(
    mr: MrWithBranches,
    strategy: MergeStrategy,
    mergedRevisionId: string | null,
    principal: Principal | undefined,
    pageCount: number,
  ): Promise<MergeMergeRequestResponse> {
    const updated = await this.prisma.mergeRequest.findUniqueOrThrow({ where: { id: mr.id }, include: MR_INCLUDE });
    const mergedRevision = mergedRevisionId ? await this.prisma.documentRevision.findUnique({ where: { id: mergedRevisionId } }) : null;
    await this.recordActivity(mr.documentId, 'merge-request.merged', mr.id, principal?.userId, {
      title: mr.title,
      strategy,
      mergedRevisionId,
      ...(pageCount > 1 ? { pageCount } : {}),
    });
    // #81: the conflicts this merge request was proposed to fix are resolved.
    // Post-commit and non-fatal: the merge stands either way.
    await this.conflicts
      .resolveMerged(mr.id, principal?.userId ?? null)
      .catch((e) => this.logger.warn(`Resolving conflicts for merge request ${mr.id} failed: ${(e as Error).message}`));
    return {
      mergeRequest: await this.toDetail(updated),
      mergedRevision: mergedRevision ? toRevisionInfo(mergedRevision) : null,
    };
  }

  /**
   * Every merge gate but breaking API changes, all before any side effect,
   * and the pages and tree changes the merge lands. Shared by the web merge
   * and a merge by push, so the two cannot disagree.
   */
  private async gates(
    mr: MrWithBranches,
    principal?: Principal,
  ): Promise<{ pages: MrPage[]; places: PagePlace[]; projectId: string; workspaceId: string }> {
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForMerge', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }

    // --- Merge gates (all before any side effect). The extra keys on these
    // ConflictException bodies are hoisted into the ApiErrorPayload `details`
    // by ApiExceptionFilter — see MergeGateConflictDetails in contracts.
    if (mr.isDraft) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.mergeRequest.isDraft', { id: mr.id }),
        reason: 'draft',
      });
    }
    // Approval gate — enforced only for real identities: in AUTH_MODE=none the
    // dev principal IS the zeros author stub (self-approval could never pass),
    // and MCP stdio has no principal. Same trust semantics as requireRole.
    const requiredApprovals =
      principal && principal.mode !== 'dev' ? (this.config.get<number>('MR_REQUIRED_APPROVALS') ?? 1) : 0;
    const approvals = this.approvers(mr).filter((id) => id !== mr.authorId).length;
    if (approvals < requiredApprovals) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.mergeRequest.needsApprovals', { id: mr.id, approvals, required: requiredApprovals }),
        reason: 'approvals',
        requiredApprovals,
        approvals,
      });
    }
    const pages = await this.changedPages(mr.sourceBranch, mr.targetBranch.name);
    const { projectId, workspaceId, defaultBranch } = await this.prisma.document.findUniqueOrThrow({
      where: { id: mr.documentId },
      select: { projectId: true, workspaceId: true, defaultBranch: true },
    });
    // ponytail: a branch's tree lands only on the default branch; a merge into another branch carries content alone.
    const places = mr.targetBranch.name === defaultBranch ? await this.treePlaces(projectId, mr.sourceBranch.name, defaultBranch) : [];
    if (pages.length === 0 && places.length === 0) throw new BadRequestException(t('error.mergeRequest.nothingToMerge'));
    this.assertTargetsExist(pages, mr.targetBranch.name);
    // The guard held the caller to edit on the page the merge request was
    // opened from; a merge writes every page it spans (#636), and every page
    // its tree moves, so each must allow it too. The guard's refusal, never a title.
    if (principal && principal.mode !== 'dev') {
      const scope = await this.permissions.scopeFor(principal, workspaceId);
      for (const id of new Set([...pages.map((p) => p.documentId), ...places.map((p) => p.documentId)])) {
        if (id !== mr.documentId) await this.permissions.requireLevel(scope, { type: 'document', id }, 'edit');
      }
    }
    // A protected target branch on any page requires workspace admin. Skipped
    // when there is no principal (MCP stdio) and short-circuited in
    // AUTH_MODE=none — the same trust semantics as every other ACL in the codebase.
    if (principal && [mr.targetBranch, ...pages.map((p) => p.target)].some((b) => b.protected)) {
      await this.access.requireRole(principal, workspaceId, 'admin');
    }
    // Style lint (#74): after approvals, before the 3-way merge — updating the
    // branch would only produce a new head to lint. Not enforced where
    // approvals are not.
    if (lintGateEnforced(principal)) {
      const gate = await this.lint.gate(mr.id, true);
      if (gate.blocked) {
        throw new ConflictException({
          statusCode: 409,
          message:
            gate.blockingCount > 0
              ? t('error.mergeRequest.lintBlocking', { id: mr.id, count: gate.blockingCount })
              : t('error.mergeRequest.lintPending', { id: mr.id }),
          reason: 'lint',
          checkStatus: gate.checkStatus,
          blockingCount: gate.blockingCount,
          checkId: gate.checkId,
        });
      }
    }

    return { pages, places, projectId, workspaceId };
  }

  /** Breaking API changes (#78), last because it parses two specs per spec page. */
  private async breakingGate(mr: MrWithBranches, pages: MrPage[]): Promise<void> {
    // Each diff runs from the merge base to the source head: the panel's
    // diff, and what a clean 3-way merge adds to the target.
    const breaking = (await this.breakingState(mr, pages)).blocking;
    if (breaking) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.mergeRequest.breakingApi', { id: mr.id, count: breaking.breaking }),
        reason: 'breaking-api',
        breakingCount: breaking.breaking,
        documentId: breaking.documentId,
      });
    }
  }

  /**
   * The moves, renames and archives a source branch makes that the default
   * branch has not (#636 phase 4): each page's latest place on the branch,
   * where it differs both from where the default branch put the page when
   * the branch forked and from where it is now. A move made on the default
   * branch since the fork therefore stands unless the branch moved the page
   * too, in which case the branch's place wins.
   */
  async treePlaces(projectId: string, source: string, target: string): Promise<PagePlace[]> {
    const rows = await this.prisma.$queryRaw<{ document_id: string; parent_document_id: string | null; slug: string; removed: boolean; seq: bigint }[]>`
      SELECT DISTINCT ON (c.document_id) c.document_id, c.parent_document_id, c.slug, c.removed, pc.seq
      FROM project_commit_changes c JOIN project_commits pc ON pc.id = c.commit_id
      WHERE pc.project_id = ${projectId}::uuid AND pc.branch = ${source}
      ORDER BY c.document_id, pc.seq DESC`;
    if (rows.length === 0) return [];
    const fork = await this.prisma.projectCommit.findFirst({ where: { projectId, branch: source }, orderBy: { seq: 'asc' }, select: { seq: true } });
    const ids = rows.map((r) => r.document_id);
    const [base, docs] = await Promise.all([
      this.prisma.$queryRaw<{ document_id: string; parent_document_id: string | null; slug: string; removed: boolean }[]>`
        SELECT DISTINCT ON (c.document_id) c.document_id, c.parent_document_id, c.slug, c.removed
        FROM project_commit_changes c JOIN project_commits pc ON pc.id = c.commit_id
        WHERE pc.project_id = ${projectId}::uuid AND pc.branch = ${target} AND pc.seq < ${fork!.seq} AND c.document_id = ANY(${ids}::uuid[])
        ORDER BY c.document_id, pc.seq DESC`,
      this.prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, parentId: true, slug: true, archivedAt: true } }),
    ]);
    const at = new Map(base.map((b) => [b.document_id, b]));
    const now = new Map(docs.map((d) => [d.id, d]));
    const same = (a: { parent_document_id: string | null; slug: string; removed: boolean } | undefined, r: (typeof rows)[number]) =>
      !!a && a.parent_document_id === r.parent_document_id && a.slug === r.slug && a.removed === r.removed;
    return rows.flatMap((r) => {
      const d = now.get(r.document_id);
      if (!d || same(at.get(r.document_id), r)) return [];
      if (same({ parent_document_id: d.parentId, slug: d.slug ?? '', removed: d.archivedAt !== null }, r)) return [];
      return [{ documentId: r.document_id, parentDocumentId: r.parent_document_id, slug: r.slug, removed: r.removed }];
    });
  }

  /**
   * Publish a working branch onto the page's default branch (#474): open a
   * merge request from it — or reuse the open one — and merge it at once. When
   * a gate refuses (a protected branch for a non-admin, approvals, lint, a
   * breaking API change, a draft MR) the merge request stays open for review
   * and `merged` is false. Nothing to publish and a conflict the author has not
   * reviewed are refused first, so a refused publish never opens anything.
   */
  async publishBranch(
    documentId: string,
    branchId: string,
    dto: PublishBranchDto,
    principal?: Principal,
  ): Promise<PublishBranchResponse> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    const source = await this.prisma.documentBranch.findFirst({ where: { id: branchId, documentId } });
    if (!source) throw new NotFoundException(t('error.branch.hidden'));
    const target = await this.getBranchOrThrow(documentId, document.defaultBranch);
    if (source.id === target.id) throw new BadRequestException(t('error.branch.publishDefault'));
    if (!source.headRevisionId) throw new BadRequestException(t('error.mergeRequest.sourceNotFinalized', { branch: source.name }));
    // Every page the branch changed (#636), checked as merge() will check them.
    const pages = await this.changedPages(source, target.name);
    if (pages.length === 0) throw new BadRequestException(t('error.mergeRequest.nothingToMerge'));
    this.assertTargetsExist(pages, target.name);
    // A conflict refuses before an MR opens (an MR makes the branch readable);
    // merge() merges again over the heads it locks.
    await this.mergedBodies(pages, { target: target.name, source: source.name }, dto.onTopOf);

    const open = await this.openFrom(source, target);
    // Opened from a page the draft changes (#636): Publish from an untouched
    // page of the draft would otherwise file the MR, its feed rows and its
    // threads under a page it leaves alone. The guard checked only this page.
    const anchor = pages.some((p) => p.documentId === documentId) ? documentId : pages[0].documentId;
    if (!open && anchor !== documentId && principal && principal.mode !== 'dev') {
      const scope = await this.permissions.scopeFor(principal, document.workspaceId);
      await this.permissions.requireLevel(scope, { type: 'document', id: anchor }, 'edit');
    }
    const mrId =
      open?.id ??
      (await this.create(anchor, { sourceBranch: source.name, title: dto.title }, principal?.userId)).mergeRequest.mergeRequestId;
    const held = async (reason: PublishBranchResponse['reason']): Promise<PublishBranchResponse> => ({
      ...(await this.get(mrId)),
      mergedRevision: null,
      merged: false,
      reason,
    });

    // merge() asks for admin on a protected target and throws; here that is a
    // review to wait for, not an error.
    if (principal && [target, ...pages.map((p) => p.target)].some((b) => b.protected)) {
      const admin = await this.access.requireRole(principal, document.workspaceId, 'admin').then(
        () => true,
        (e: unknown) => {
          if (e instanceof ForbiddenException) return false;
          throw e;
        },
      );
      if (!admin) return held('protected');
    }
    try {
      return { ...(await this.merge(mrId, 'merge-commit', principal, { onTopOf: dto.onTopOf })), merged: true, reason: null };
    } catch (e) {
      const reason = e instanceof ConflictException ? (e.getResponse() as { reason?: unknown }).reason : undefined;
      if (reason === 'approvals' || reason === 'lint' || reason === 'breaking-api' || reason === 'draft') return held(reason);
      throw e;
    }
  }

  /**
   * The 3-way state of a merge request (#636): how many pages are behind their
   * target, and every conflicting page `scope` may open, with git's markers for
   * the conflict view. A closed or merged one has nothing to merge.
   */
  async mergeConflicts(mergeRequestId: string, scope: AccessScope): Promise<MergeRequestConflictsResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    const pages = mr.status === 'open' ? (await this.changedPages(mr.sourceBranch, mr.targetBranch.name)).filter(behind) : [];
    const labels = { target: mr.targetBranch.name, source: mr.sourceBranch.name };
    // ponytail: merges every behind page on each read; cache by (base, target, source) heads if an MR page gets slow.
    const conflicted: { page: MrPage; merged: Extract<ThreeWayResult, { clean: false }> }[] = [];
    for (const page of pages) {
      const { merged } = await this.threeWayOf(page, labels);
      if (merged && !merged.clean) conflicted.push({ page, merged });
    }
    const visible = await this.permissions.visibleDocumentIds(scope, conflicted.map((c) => c.page.documentId));
    const shown = conflicted.filter((c) => visible.has(c.page.documentId));
    const titles = new Map(
      (await this.prisma.document.findMany({ where: { id: { in: shown.map((c) => c.page.documentId) } }, select: { id: true, title: true } })).map(
        (d) => [d.id, d.title],
      ),
    );
    return {
      mergeRequestId: mr.id,
      behind: pages.length,
      pages: shown.map(({ page, merged }) => ({
        documentId: page.documentId,
        title: titles.get(page.documentId) ?? '',
        targetHeadRevisionId: page.target.headRevisionId!,
        sourceHeadRevisionId: page.source.headRevisionId,
        hunks: merged.hunks,
        text: merged.text,
      })),
      hiddenPages: conflicted.length - shown.length,
    };
  }

  /**
   * "Update branch" (#636): merge the target into the source on every page
   * whose target moved past the merge base. Each gets a revision on the source
   * branch parented on its head (order 1) and the target head (order 2), and
   * the update is one project commit, so every fetcher of the branch
   * fast-forwards — history is append-only, so this replaces a rebase. A
   * conflicting page needs a resolution, the body a person resolved against
   * that target head; while one is missing the update refuses with `conflict`.
   */
  async updateBranch(
    mergeRequestId: string,
    dto: UpdateMergeRequestBranchDto,
    principal?: Principal,
  ): Promise<UpdateMergeRequestBranchResponse> {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(t('error.mergeRequest.notOpenForUpdate', { id: mr.id, status: t(`status.mr.${mr.status}`) }));
    }
    const pages = (await this.changedPages(mr.sourceBranch, mr.targetBranch.name)).filter(behind);
    if (pages.length === 0) throw new BadRequestException(t('error.mergeRequest.upToDate', { target: mr.targetBranch.name }));
    const { projectId, workspaceId } = await this.prisma.document.findUniqueOrThrow({
      where: { id: mr.documentId },
      select: { projectId: true, workspaceId: true },
    });
    // It writes every page it updates, as a merge does: edit on each, and an
    // admin for a protected source branch.
    if (principal && principal.mode !== 'dev') {
      const scope = await this.permissions.scopeFor(principal, workspaceId);
      for (const p of pages) {
        if (p.documentId !== mr.documentId) await this.permissions.requireLevel(scope, { type: 'document', id: p.documentId }, 'edit');
      }
    }
    if (principal && pages.some((p) => p.source.protected)) await this.access.requireRole(principal, workspaceId, 'admin');

    const labels = { target: mr.targetBranch.name, source: mr.sourceBranch.name };
    const resolutions = new Map((dto.resolutions ?? []).map((r) => [r.documentId, r]));
    const bodies = new Map<string, Body>();
    const conflicts: { page: MrPage; hunks: MergeConflictHunk[] }[] = [];
    for (const p of pages) {
      const { source, merged } = await this.threeWayOf(p, labels);
      if (merged!.clean) {
        bodies.set(p.documentId, { text: merged!.text, contentType: source.contentType });
        continue;
      }
      const r = resolutions.get(p.documentId);
      if (!r) {
        conflicts.push({ page: p, hunks: merged!.hunks });
        continue;
      }
      if (r.targetHeadRevisionId !== p.target.headRevisionId) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.mergeRequest.resolutionStale', { target: mr.targetBranch.name }),
          reason: 'diverged',
          documentId: p.documentId,
          currentHeadRevisionId: p.target.headRevisionId,
          sourceHeadRevisionId: p.source.headRevisionId,
        });
      }
      if (hasConflictMarkers(r.content)) throw new BadRequestException(t('error.mergeRequest.markersLeft', { documentId: p.documentId }));
      bodies.set(p.documentId, { text: r.content, contentType: source.contentType });
    }
    if (conflicts.length) throw this.conflict(conflicts, labels);

    const message = `Merge branch '${mr.targetBranch.name}' into '${mr.sourceBranch.name}'`;
    const drafts: string[] = [];
    try {
      const staged: { page: MrPage; revisionId: string }[] = [];
      for (const p of pages) {
        const second = { id: p.target.headRevisionId!, order: 2 };
        staged.push({ page: p, revisionId: await this.stage(drafts, p.documentId, p.source.name, message, bodies.get(p.documentId)!, second) });
      }
      await this.prisma.withTransaction(
        async () => {
          // The same lock order as merge(): the project's commit lock, then the
          // branch rows in id order. A write to the source since the merge was
          // computed would be overwritten, so it refuses instead.
          await this.commits.lock(projectId);
          const headNow = await this.lockHeads(pages.map((p) => p.source.id));
          if (pages.some((p) => headNow.get(p.source.id) !== p.source.headRevisionId)) {
            throw new ConflictException(t('error.mergeRequest.concurrentChange', { id: mr.id }));
          }
          // `dedupe: false`: a resolution that keeps the source's body is still
          // the merge node that moves the merge base.
          const revisionIds: string[] = [];
          for (const x of staged) {
            revisionIds.push((await this.documents.finalizeRevision(x.page.documentId, x.revisionId, { commit: false, dedupe: false })).revisionId);
          }
          await this.commits.recordRevisions(revisionIds, { authorId: principal?.userId, mergedFrom: mr.targetBranch.name });
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (e) {
      await this.dropDrafts(drafts);
      throw e;
    }

    await this.recordActivity(mr.documentId, 'merge-request.updated', mr.id, principal?.userId, {
      title: mr.title,
      changed: ['branch'],
      ...(pages.length > 1 ? { pageCount: pages.length } : {}),
    });
    return { ...(await this.get(mr.id)), updated: pages.length };
  }

  /**
   * What each page lands with (#636). A page whose target still sits at the
   * merge base takes the source head's body, as a fast-forward would; one
   * whose target moved, the 3-way merge of both sides. Where its hunks
   * overlap, the source's body wins only over a target head `onTopOf` lists
   * (the author reviewed it); otherwise the whole merge refuses with
   * `conflict`, before anything is staged.
   */
  private async mergedBodies(pages: MrPage[], labels: MergeLabels, onTopOf: readonly string[] = []): Promise<Map<string, Body>> {
    const bodies = new Map<string, Body>();
    const conflicts: { page: MrPage; hunks: MergeConflictHunk[] }[] = [];
    for (const p of pages) {
      const { source, merged } = await this.threeWayOf(p, labels);
      if (merged && !merged.clean && !onTopOf.includes(p.target.headRevisionId!)) conflicts.push({ page: p, hunks: merged.hunks });
      bodies.set(p.documentId, { text: merged?.clean ? merged.text : source.text, contentType: source.contentType });
    }
    if (conflicts.length) throw this.conflict(conflicts, labels);
    return bodies;
  }

  /** The source head's body and, when the target moved past the merge base, the 3-way merge of both sides. */
  private async threeWayOf(p: MrPage, labels: MergeLabels): Promise<{ source: Body; merged: ThreeWayResult | null }> {
    const source = await this.bodyOf(p.source.headRevisionId);
    if (!behind(p)) return { source, merged: null };
    // No common ancestor (git's unrelated histories): each side is all additions.
    const base = p.mergeBase ? (await this.bodyOf(p.mergeBase)).text : '';
    return { source, merged: threeWay(base, (await this.bodyOf(p.target.headRevisionId!)).text, source.text, labels) };
  }

  private async bodyOf(revisionId: string): Promise<Body> {
    const r = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { s3Key: true, contentType: true } });
    return { text: await this.storage.getObjectText(r.s3Key), contentType: r.contentType };
  }

  /** 409 `conflict` naming every conflicting page and its hunks, and the first page as `diverged` named it. Ids, never titles. */
  private conflict(conflicts: { page: MrPage; hunks: MergeConflictHunk[] }[], labels: MergeLabels): ConflictException {
    const [{ page }] = conflicts;
    return new ConflictException({
      statusCode: 409,
      message: t('error.mergeRequest.conflict', { target: labels.target, source: labels.source, count: conflicts.length }),
      reason: 'conflict',
      conflicts: conflicts.map((c) => ({ documentId: c.page.documentId, hunks: c.hunks })),
      documentId: page.documentId,
      currentHeadRevisionId: page.target.headRevisionId,
      sourceHeadRevisionId: page.source.headRevisionId,
      comparisonUrl: `/v1/documents/${page.documentId}/compare?from=${page.target.headRevisionId}&to=${page.source.headRevisionId}&mode=merge-base`,
    });
  }

  /**
   * A draft revision on `branch` with `body`: createRevision parents it on the
   * branch head (order 1), and a merge adds `second`, the head merged in. Its
   * id goes into `drafts` first, so a failure halfway is cleaned up too.
   */
  private async stage(
    drafts: string[],
    documentId: string,
    branch: string,
    message: string,
    body: Body,
    second: { id: string; order: number } | null,
  ): Promise<string> {
    const { revisionId } = await this.documents.createRevision(documentId, { branch, message, contentType: body.contentType });
    drafts.push(revisionId);
    if (second) await this.prisma.revisionParent.create({ data: { revisionId, parentRevisionId: second.id, parentOrder: second.order } });
    const row = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { s3Key: true } });
    await this.storage.putObjectText(row.s3Key, body.text, body.contentType);
    return revisionId;
  }

  /** Locks branch rows in id order, so writers sharing pages serialize rather than deadlock, and reads their heads. */
  private async lockHeads(branchIds: string[]): Promise<Map<string, string | null>> {
    const locked = await this.prisma.$queryRaw<{ id: string; head_revision_id: string | null }[]>`
      SELECT id, head_revision_id FROM document_branches WHERE id = ANY(${branchIds}::uuid[]) ORDER BY id FOR UPDATE
    `;
    return new Map(locked.map((r) => [r.id, r.head_revision_id]));
  }

  /** What a transaction never finalized is a draft nobody will finish. */
  private async dropDrafts(ids: string[]): Promise<void> {
    const drafts = { id: { in: ids }, status: 'draft' };
    await this.prisma.revisionParent.deleteMany({ where: { revision: drafts } }).catch(() => undefined);
    await this.prisma.documentRevision.deleteMany({ where: drafts }).catch(() => undefined);
  }

  /**
   * The open merge request from `source`'s branch into `target`'s, on any page
   * (#636): a project branch has one merge request per target, whichever
   * page opened it.
   */
  private openFrom(source: DocumentBranch, target: DocumentBranch): Promise<{ id: string } | null> {
    return this.prisma.mergeRequest.findFirst({
      where: {
        status: 'open',
        sourceBranch: source.projectBranchId ? { projectBranchId: source.projectBranchId } : { id: source.id },
        targetBranch: source.projectBranchId ? { name: target.name } : { id: target.id },
      },
      select: { id: true },
    });
  }

  /** 409 when an open MR already exists for the same (source, target) pair. */
  private async rejectDuplicateOpen(source: DocumentBranch, target: DocumentBranch): Promise<void> {
    const existing = await this.openFrom(source, target);
    if (existing) {
      throw new ConflictException(
        t('error.mergeRequest.alreadyOpen', { id: existing.id, source: source.name, target: target.name }),
      );
    }
  }

  /**
   * Merge base costs a graph BFS — computed for detail reads and mutation
   * responses only; list endpoints pass null (documented in contracts).
   */
  private async mergeBaseOf(mr: MrWithBranches): Promise<string | null> {
    const src = mr.sourceBranch.headRevisionId;
    const tgt = mr.targetBranch.headRevisionId;
    return src && tgt ? await this.compare.findMergeBase(mr.documentId, tgt, src) : null;
  }

  /** Batched review-thread counts (one groupBy per response, list rows included). */
  private async statsFor(ids: string[]): Promise<Map<string, { total: number; unresolved: number }>> {
    const map = new Map<string, { total: number; unresolved: number }>(
      ids.map((id) => [id, { total: 0, unresolved: 0 }]),
    );
    if (ids.length === 0) return map;
    const rows = await this.prisma.mergeRequestThread.groupBy({
      by: ['mergeRequestId', 'resolved', 'resolvable'],
      where: { mergeRequestId: { in: ids } },
      _count: { _all: true },
    });
    for (const row of rows) {
      const entry = map.get(row.mergeRequestId)!;
      entry.total += row._count._all;
      // A plain comment is a remark, not an open request — it can never be
      // resolved, so counting it as unresolved would block a merge forever.
      if (!row.resolved && row.resolvable) entry.unresolved += row._count._all;
    }
    return map;
  }

  /** How many pages each merge request's source branch wrote (#636), one groupBy per response. */
  private async pagesFor(mrs: MrWithBranches[]): Promise<Map<string, number>> {
    const ids = [...new Set(mrs.flatMap((mr) => (mr.sourceBranch.projectBranchId ? [mr.sourceBranch.projectBranchId] : [])))];
    const rows = ids.length
      ? await this.prisma.documentBranch.groupBy({
          by: ['projectBranchId'],
          where: { projectBranchId: { in: ids }, ...WROTE },
          _count: { _all: true },
        })
      : [];
    const byBranch = new Map(rows.map((r) => [r.projectBranchId, r._count._all]));
    return new Map(mrs.map((mr) => [mr.id, byBranch.get(mr.sourceBranch.projectBranchId) ?? 1]));
  }

  /** Detail/mutation response body: info with merge base + thread stats. */
  private async toDetail(mr: MrWithBranches): Promise<MergeRequestInfo> {
    const [mergeBase, stats, pages] = await Promise.all([this.mergeBaseOf(mr), this.statsFor([mr.id]), this.pagesFor([mr])]);
    return this.toInfo(mr, mergeBase, stats.get(mr.id), pages.get(mr.id));
  }

  /**
   * A project's branches as `scope` sees them (#636): each with the pages it
   * wrote that `scope` may open, on page branches it may read (#474), newest
   * first. The default branch is every page's, so it is left out, and so is a
   * branch with nothing left in view.
   */
  async projectBranches(projectId: string, scope: AccessScope): Promise<ListProjectBranchesResponse> {
    const rows = await this.prisma.documentBranch.findMany({
      where: { projectBranch: { projectId }, document: { AND: [visibilityWhere(scope)] }, ...WROTE },
      select: {
        id: true,
        name: true,
        ownerId: true,
        restricted: true,
        documentId: true,
        projectBranchId: true,
        document: { select: { title: true, defaultBranch: true } },
      },
      orderBy: { document: { title: 'asc' } },
    });
    const readable = await this.permissions.readableBranchIds(
      scope,
      rows.filter((b) => b.name !== b.document.defaultBranch),
    );
    const shown = rows.filter((b) => readable.has(b.id));
    const ids = shown.map((b) => b.id);
    const [latest, open] = await Promise.all([
      this.prisma.documentRevision.findMany({
        where: { branchId: { in: ids }, status: { not: 'draft' } },
        orderBy: { createdAt: 'desc' },
        distinct: ['branchId'],
        select: { branchId: true, createdAt: true, authorId: true },
      }),
      this.prisma.mergeRequest.findMany({
        where: { status: 'open', sourceBranchId: { in: ids }, document: { AND: [visibilityWhere(scope)] } },
        select: { id: true, title: true, isDraft: true, sourceBranchId: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const byBranch = new Map<string, ListProjectBranchesResponse['branches'][number]>();
    for (const b of shown) {
      const key = b.projectBranchId!;
      const entry = byBranch.get(key) ?? {
        projectBranchId: key,
        name: b.name,
        pages: [],
        updatedAt: new Date(0).toISOString(),
        updatedBy: AUTHOR_ID_STUB,
        openMergeRequest: null,
      };
      entry.pages.push({ documentId: b.documentId, title: b.document.title });
      const rev = latest.find((r) => r.branchId === b.id);
      if (rev && rev.createdAt.toISOString() > entry.updatedAt) {
        entry.updatedAt = rev.createdAt.toISOString();
        entry.updatedBy = rev.authorId;
      }
      const mr = open.find((m) => m.sourceBranchId === b.id);
      if (mr && !entry.openMergeRequest) entry.openMergeRequest = { mergeRequestId: mr.id, title: mr.title, isDraft: mr.isDraft };
      byBranch.set(key, entry);
    }
    return { projectId, branches: [...byBranch.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }

  /** 400 unless every id reads the document's workspace — a member, and not a guest (#76). */
  private async assertWorkspaceMembers(documentId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const doc = await this.prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { workspaceId: true },
    });
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: doc.workspaceId, userId: { in: userIds }, ...WORKSPACE_READER },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    const unknown = userIds.filter((id) => !memberIds.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(t('error.mergeRequest.notMembers', { users: unknown.join(', ') }));
    }
    // Reviewing a page is reading it: someone the page's restrictions keep out
    // cannot be handed it (#76). A 409, because a grant on the page fixes it.
    const admitted = await this.permissions.whoCanOpen({ type: 'document', id: documentId }, userIds);
    const shut = userIds.filter((id) => !admitted.has(id));
    if (shut.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.access.usersWithoutView', { users: shut.join(', ') }),
        reason: 'access.usersWithoutView',
        users: shut,
      });
    }
  }

  private toInfo(
    mr: MrWithBranches,
    mergeBase: string | null,
    threadStats: { total: number; unresolved: number } = { total: 0, unresolved: 0 },
    pageCount = 1,
  ): MergeRequestInfo {
    return {
      mergeRequestId: mr.id,
      documentId: mr.documentId,
      title: mr.title,
      description: mr.description,
      sourceBranch: mr.sourceBranch.name,
      targetBranch: mr.targetBranch.name,
      sourceHeadRevisionId: mr.sourceBranch.headRevisionId,
      targetHeadRevisionId: mr.targetBranch.headRevisionId,
      mergeBaseRevisionId: mergeBase,
      status: mr.status as MergeRequestStatus,
      isDraft: mr.isDraft,
      authorId: mr.authorId,
      assigneeId: mr.assigneeId,
      approvedBy: this.approvers(mr),
      reviewers: mr.reviewers.map((r) => r.userId),
      threadStats,
      strategy: (mr.strategy as MergeStrategy | null) ?? null,
      mergedRevisionId: mr.mergedRevisionId,
      createdAt: mr.createdAt.toISOString(),
      mergedAt: mr.mergedAt?.toISOString() ?? null,
      closedAt: mr.closedAt?.toISOString() ?? null,
      provenance: mr.provenance as MergeRequestProvenance,
      captureId: mr.captureId,
      pageCount,
    };
  }

  private approvers(mr: MergeRequest): string[] {
    return Array.isArray(mr.approvedBy) ? (mr.approvedBy as string[]) : [];
  }


  /**
   * Public so MergeRequestThreadsService can record against the same funnel.
   *
   * Returns the page it resolved (or null when the page is gone) because the
   * workspace lives on the document, not on the merge request — callers that
   * need it for a notification would otherwise repeat this exact lookup.
   */
  async recordActivity(
    documentId: string,
    action: string,
    subjectId: string,
    actor?: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ workspaceId: string; title: string } | null> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true, title: true },
    });
    if (!doc) return null;
    // The lookup stays inline — callers use the returned page synchronously —
    // but the record itself is post-commit: it publishes onto the Redis bus and
    // fans out notifications, neither of which can be taken back. Callers that
    // run inside a transaction (merge, agent-finding proposals) would otherwise
    // announce a merge request that has not committed. Outside a transaction
    // `onCommit` runs it immediately, so every other caller is unchanged.
    this.prisma.onCommit(() =>
      this.activity.record({
        workspaceId: doc.workspaceId,
        actor,
        action,
        documentId,
        subjectId,
        metadata: { documentTitle: doc.title, ...metadata },
      }),
    );
    return doc;
  }

  private async getMrOrThrow(mergeRequestId: string): Promise<MrWithBranches> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: MR_INCLUDE,
    });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    return mr;
  }

  async getBranchOrThrow(documentId: string, name: string): Promise<DocumentBranch> {
    const branch = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name } },
    });
    if (!branch) throw new NotFoundException(t('error.branch.notFound', { name, documentId }));
    return branch;
  }
}
