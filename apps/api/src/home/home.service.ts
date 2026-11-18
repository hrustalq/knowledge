import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ANALYTICS_DEFAULT_DAYS,
  homeLayoutOf,
  type HomeLayoutResponse,
  type HomeMetrics,
  type HomeNeedsYou,
  type HomeResponse,
  type HomeWidget,
  type WorkspaceFeature,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { LISTED_PAGE } from '../common/listed-page.js';
import type { Principal } from '../auth/principal.js';
import { FeaturesService } from '../auth/features.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { KnowledgeHealthService } from '../verification/knowledge-health.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AnalyticsQueryService } from '../analytics/analytics-query.service.js';
import { AgentRunsService } from '../ai/ai-agents.service.js';
import { recentPages } from '../projects/project-overview.service.js';

const LIST_LIMIT = 5;
const ACTIVITY_LIMIT = 8;

/**
 * The workspace home (#1243): one read for the widgets the workspace shows.
 *
 * Every widget is an existing read under the caller's scope, asked only when
 * the widget is in the layout; nothing is stored but the layout. A guest gets
 * what their routes would give them (pages, activity, their inbox) and none of
 * what refuses guests (merge requests, agent runs, health, analytics).
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly features: FeaturesService,
    private readonly activity: ActivityService,
    private readonly health: KnowledgeHealthService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsQueryService,
    private readonly runs: AgentRunsService,
  ) {}

  async layout(workspaceId: string): Promise<HomeLayoutResponse> {
    const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { homeWidgets: true } });
    const stored = row?.homeWidgets ?? null;
    return { workspaceId, layout: homeLayoutOf(stored), custom: Array.isArray(stored) };
  }

  /** Null goes back to the built-in layout. */
  async setLayout(workspaceId: string, widgets: HomeWidget[] | null, actorId: string): Promise<HomeLayoutResponse> {
    const homeWidgets = widgets === null ? null : homeLayoutOf(widgets);
    // Prisma spells a SQL NULL in a Json column `DbNull`; a bare null is refused.
    const value = homeWidgets ?? Prisma.DbNull;
    await this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, homeWidgets: value, updatedBy: actorId },
      update: { homeWidgets: value, updatedBy: actorId },
    });
    return this.layout(workspaceId);
  }

  async get(scope: AccessScope, principal: Principal): Promise<HomeResponse> {
    const { workspaceId } = scope;
    const [{ layout, custom }, disabled] = await Promise.all([this.layout(workspaceId), this.features.disabled(workspaceId)]);
    const on = (f: WorkspaceFeature) => !disabled.includes(f) && !this.features.unavailable().includes(f);
    const member = !scope.guest;
    const widgets = layout.filter((w) => member || w !== 'agents');
    const has = (w: HomeWidget) => widgets.includes(w);
    const listed: Prisma.DocumentWhereInput = { workspaceId, ...LISTED_PAGE, AND: [visibilityWhere(scope)] };

    const [metrics, needsYou, recent, activity, agents] = await Promise.all([
      has('metrics') ? this.metrics(scope, listed, member, on) : undefined,
      has('needs-you') ? this.needsYou(scope, member) : undefined,
      has('recent') ? recentPages(this.prisma, listed) : undefined,
      has('activity') ? this.activity.list(workspaceId, { limit: ACTIVITY_LIMIT }, scope).then((r) => r.entries) : undefined,
      has('agents') ? this.agents(workspaceId, principal) : undefined,
    ]);
    return { workspaceId, layout, custom, widgets, metrics, needsYou, recent, activity, agents };
  }

  private async metrics(
    scope: AccessScope,
    listed: Prisma.DocumentWhereInput,
    member: boolean,
    on: (f: WorkspaceFeature) => boolean,
  ): Promise<HomeMetrics> {
    const health = member && on('knowledge-health');
    const admin = scope.bypass || scope.role === 'admin';
    const [summary, pages, openMergeRequests, overview] = await Promise.all([
      health ? this.health.summary(scope) : null,
      // The health summary already counts pages (without archived pages and
      // scaffold stubs), and the verified share must divide by that number.
      health ? null : this.prisma.document.count({ where: { ...listed, archivedAt: null } }),
      member
        ? this.prisma.mergeRequest.count({ where: { status: 'open', document: { workspaceId: scope.workspaceId, AND: [visibilityWhere(scope)] } } })
        : null,
      admin && on('analytics') ? this.analytics.overview(scope, ANALYTICS_DEFAULT_DAYS) : null,
    ]);
    return {
      pages: summary?.total ?? pages ?? 0,
      verified: summary?.verified ?? null,
      stale: summary?.counts.stale ?? null,
      openMergeRequests,
      unansweredSearches: overview?.zeroResultSearches ?? null,
      searchDays: ANALYTICS_DEFAULT_DAYS,
    };
  }

  private async needsYou(scope: AccessScope, member: boolean): Promise<HomeNeedsYou> {
    const [reviews, inbox] = await Promise.all([
      member
        ? this.mergeRequests.listWorkspace(
            { workspaceId: scope.workspaceId, reviewerId: scope.userId, status: 'open', limit: LIST_LIMIT },
            scope,
          )
        : null,
      this.notifications.list(scope.workspaceId, scope.userId, { unread: true, limit: LIST_LIMIT }),
    ]);
    return {
      reviews: reviews?.mergeRequests.map((mr) => ({ id: mr.mergeRequestId, title: mr.title, authorId: mr.authorId, createdAt: mr.createdAt })) ?? null,
      reviewCount: reviews?.counts.open ?? 0,
      notifications: inbox.entries.map((n) => ({ id: n.id, title: n.title, documentId: n.documentId, createdAt: n.createdAt })),
      unreadCount: inbox.unreadCount,
    };
  }

  private async agents(workspaceId: string, principal: Principal): Promise<NonNullable<HomeResponse['agents']>> {
    const list = await this.runs.list(workspaceId, { status: 'running' }, principal);
    return {
      runs: list.runs.slice(0, LIST_LIMIT).map((r) => ({
        id: r.id,
        agentName: r.agentName,
        stage: r.stage,
        startedAt: r.startedAt ?? r.createdAt,
      })),
      queued: list.counts.pending,
    };
  }
}
