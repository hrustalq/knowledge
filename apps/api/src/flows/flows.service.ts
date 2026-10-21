import { Injectable } from '@nestjs/common';
import {
  captureDecisionFlow,
  FLOW_NO_LINK,
  FLOW_SCOPE_SUBTREE,
  markOutdatedFlow,
  nextQuestion,
  prune,
} from '@knowledge/contracts';
import type {
  CaptureResult,
  CaptureSession,
  FlowAnswers,
  FlowDrop,
  FlowKey,
  FlowOption,
  FlowScenario,
  FlowStep,
  FlowText,
  KnowledgeHealthBulkResult,
} from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import { CaptureService } from '../captures/capture.service.js';
import { LISTED_PAGE } from '../common/listed-page.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { t } from '../i18n/t.js';
import type { AccessScope } from '../permissions/access-scope.js';
import { visibilityWhere } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import { KnowledgeHealthService } from '../verification/knowledge-health.service.js';

/**
 * One call of a flow-bearing task: either the question to ask next, or the
 * task's result once nothing is open. `dropped` is what `prune` set aside
 * (a changed answer, a skip-ahead, a stale value) so the caller can say so.
 */
export type FlowRun<T> =
  | { status: 'needs_input'; flow: FlowKey; step: FlowStep; answers: FlowAnswers; dropped: FlowDrop[] }
  | { status: 'done'; answers: FlowAnswers; dropped: FlowDrop[]; result: T };

export interface CaptureDecisionArgs {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string[];
  /** Given → nothing is asked; the capture runs as before. */
  projectId?: string;
  /** The caller's suggestion: offered first, the first one recommended. */
  relatedDocumentIds?: string[];
  session: CaptureSession;
}

export interface CaptureDecisionResult extends CaptureResult {
  /** The reviewer the person picked, when one was assigned to a new merge request. */
  reviewerId: string | null;
}

export interface MarkOutdatedArgs {
  documentId: string;
  /** Given → the reason question is answered already. */
  reason?: string;
}

export interface MarkOutdatedResult {
  results: KnowledgeHealthBulkResult[];
  /** The subtree was too large to offer here; only the page itself was in scope. */
  subtreeTooLarge: boolean;
}

// ponytail: option lists are capped rather than paged. A workspace past these
// needs a picker with search, not a longer radio list.
const MAX_PROJECTS = 20;
const MAX_PAGES = 6;
const MAX_REVIEWERS = 20;
/** A subtree wider than this is not offered: the checklist would be unanswerable. Knowledge health bulk-marks it instead. */
const MAX_DESCENDANTS = 50;

/**
 * The question flows' server half (#425): fills a scenario's options from
 * workspace data the caller may see, walks it with the pure functions in
 * `@knowledge/contracts/flows`, and runs the task once nothing is open.
 * Transport-free, so the assistant's tools and the MCP tools ask the same
 * questions with the same options.
 *
 * Every option list is read under the caller's `AccessScope`: a page they
 * cannot open is never offered, and a value that is not on offer fails
 * `validate` — so an answer can never reach past what the person could pick.
 */
@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly search: SearchService,
    private readonly captures: CaptureService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly health: KnowledgeHealthService,
  ) {}

  /** Capture a decision: project → related page → reviewer, asked only when no project was given. */
  async captureDecision(
    principal: Principal,
    workspaceId: string,
    args: CaptureDecisionArgs,
    given: Record<string, unknown>,
  ): Promise<FlowRun<CaptureDecisionResult>> {
    let projectId = args.projectId;
    let relatedDocumentIds = args.relatedDocumentIds;
    let reviewerId: string | null = null;
    let answers: FlowAnswers = {};
    let dropped: FlowDrop[] = [];

    if (!projectId) {
      const scope = await this.permissions.scopeFor(principal, workspaceId);
      const { scenario, seeded } = await this.captureDecisionScenario(principal, scope, args, given);
      ({ answers, dropped } = prune(scenario, seeded));
      const step = nextQuestion(scenario, answers);
      if (step) return { status: 'needs_input', flow: scenario.flow, step, answers, dropped };
      projectId = String(answers.project);
      relatedDocumentIds =
        typeof answers.relatedPage === 'string' && answers.relatedPage !== FLOW_NO_LINK ? [answers.relatedPage] : undefined;
      reviewerId = typeof answers.reviewer === 'string' ? answers.reviewer : null;
    }

    const capture = await this.captures.capture(
      {
        kind: 'decision',
        workspaceId,
        projectId,
        title: args.title,
        context: args.context,
        decision: args.decision,
        ...(args.consequences ? { consequences: args.consequences } : {}),
        ...(args.alternatives?.length ? { alternatives: args.alternatives } : {}),
        ...(relatedDocumentIds?.length ? { relatedDocumentIds } : {}),
        session: args.session,
      },
      principal,
    );
    // Only on a merge request this capture opened: a duplicate points at an
    // earlier one, and `setReviewers` replaces whoever is assigned there.
    let assigned: string | null = null;
    if (reviewerId && capture.mergeRequestId && capture.state === 'proposed') {
      await this.mergeRequests.setReviewers(capture.mergeRequestId, [reviewerId], principal.userId);
      assigned = reviewerId;
    }
    return { status: 'done', answers, dropped, result: { ...capture, reviewerId: assigned } };
  }

  /** Mark a page outdated: scope → exclusions → reason. The caller has checked edit on the page. */
  async markOutdated(
    principal: Principal,
    workspaceId: string,
    args: MarkOutdatedArgs,
    given: Record<string, unknown>,
  ): Promise<FlowRun<MarkOutdatedResult>> {
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const rows = await this.prisma.document.findMany({
      where: {
        workspaceId,
        path: { contains: `/${args.documentId}/` },
        id: { not: args.documentId },
        archivedAt: null,
        ...LISTED_PAGE,
        AND: [visibilityWhere(scope)],
      },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
      select: { id: true, title: true },
      take: MAX_DESCENDANTS + 1,
    });
    const subtreeTooLarge = rows.length > MAX_DESCENDANTS;
    const descendants: FlowOption[] = subtreeTooLarge ? [] : rows.map((d) => ({ value: d.id, label: d.title }));
    const scenario = markOutdatedFlow({ descendants }, this.text(principal));
    const seedReason = Boolean(args.reason?.trim()) && !('reason' in given);
    const seeded = seedReason ? { ...given, reason: args.reason } : given;

    const pruned = prune(scenario, seeded);
    const answers = pruned.answers;
    // The seeded reason waits behind the open questions; that is not news to the caller.
    const dropped = seedReason ? pruned.dropped.filter((d) => d.question !== 'reason') : pruned.dropped;
    const step = nextQuestion(scenario, answers);
    if (step) return { status: 'needs_input', flow: scenario.flow, step, answers, dropped };

    const excluded = new Set(Array.isArray(answers.exclusions) ? answers.exclusions : []);
    const documentIds = [
      args.documentId,
      ...(answers.scope === FLOW_SCOPE_SUBTREE ? descendants.map((d) => d.value).filter((id) => !excluded.has(id)) : []),
    ];
    const note = typeof answers.reason === 'string' ? answers.reason : undefined;
    const { results } = await this.health.bulk(scope, { action: 'outdated', documentIds, ...(note ? { note } : {}) }, principal.userId);
    return { status: 'done', answers, dropped, result: { results, subtreeTooLarge } };
  }

  /** The scenario's labels, in the caller's language. */
  private text(principal: Principal): FlowText {
    return (key, params) => t(`flow.${key}`, params, principal.locale);
  }

  private async captureDecisionScenario(
    principal: Principal,
    scope: AccessScope,
    args: CaptureDecisionArgs,
    given: Record<string, unknown>,
  ): Promise<{ scenario: FlowScenario; seeded: Record<string, unknown> }> {
    const { workspaceId } = scope;
    const pin = principal.apiKey?.projectIds;
    const projects = (
      await this.prisma.project.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } })
    )
      // The same two refusals `CaptureService.assertProjectAllowed` makes.
      .filter((p) => !scope.denied.has(p.id) && (!pin || pin.includes(p.id)))
      .slice(0, MAX_PROJECTS)
      .map((p, i): FlowOption => ({ value: p.id, label: p.name, ...(i === 0 ? { recommended: true } : {}) }));

    // The caller's suggestion first, then what search finds for the title, then
    // the page already picked — so a reranked index never invalidates an answer.
    const picked = typeof given.relatedPage === 'string' && given.relatedPage !== FLOW_NO_LINK ? [given.relatedPage] : [];
    const hits = await this.search
      .search({ workspaceId, query: args.title, mode: 'hybrid', limit: MAX_PAGES }, scope)
      .then((r) => r.results.map((h) => h.documentId))
      .catch(() => [] as string[]);
    const suggested = args.relatedDocumentIds ?? [];
    const candidates = [...new Set([...suggested, ...hits, ...picked])];
    const visible = await this.prisma.document.findMany({
      where: { id: { in: candidates }, workspaceId, ...LISTED_PAGE, AND: [visibilityWhere(scope)] },
      select: { id: true, title: true, ownerId: true },
    });
    const byId = new Map(visible.map((d) => [d.id, d]));
    const pages = candidates
      .filter((id) => byId.has(id))
      .filter((id, i) => i < MAX_PAGES || picked.includes(id))
      .map(
      (id): FlowOption => ({
        value: id,
        label: byId.get(id)!.title,
        ...(id === suggested.find((s) => byId.has(s)) ? { recommended: true } : {}),
      }),
    );

    // Reviewers only once a page is linked: its owner first and recommended,
    // then the workspace's editors. The author is not their own reviewer.
    let reviewers: FlowOption[] = [];
    const page = picked[0] ? byId.get(picked[0]) : undefined;
    if (page) {
      const members = await this.prisma.workspaceMember.findMany({
        where: { workspaceId, role: { in: ['editor', 'admin'] }, userId: { not: principal.userId } },
        select: { userId: true, user: { select: { displayName: true } } },
        orderBy: { user: { displayName: 'asc' } },
        take: MAX_REVIEWERS,
      });
      reviewers = members
        .map((m): FlowOption => ({
          value: m.userId,
          label: m.user.displayName,
          ...(m.userId === page.ownerId ? { recommended: true } : {}),
        }))
        .sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true));
    }
    // Nobody to pick: the optional question is answered "skipped" rather than
    // asked with no options.
    const seeded = page && reviewers.length === 0 && !('reviewer' in given) ? { ...given, reviewer: null } : given;
    return { scenario: captureDecisionFlow({ projects, pages, reviewers }, this.text(principal)), seeded };
  }
}
