import { Injectable } from '@nestjs/common';
import type { MemberCapability, WorkspaceRole } from '@knowledge/contracts';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { CompareService } from '../documents/compare.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { MergeRequestThreadsService } from '../documents/merge-request-threads.service.js';
import { SearchService } from '../search/search.service.js';
import { EntitiesService } from '../entities/entities.service.js';
import { GraphService } from '../graph/graph.service.js';
import { GraphQueryService } from '../graph/graph-query.service.js';
import { PermissionService, type BranchRefs } from '../permissions/permission.service.js';
import { WorkItemHandoffService } from '../connectors/handoff/work-item-handoff.service.js';
import { ResourceAccessService } from '../permissions/resource-access.service.js';
import { AccessRequestsService } from '../permissions/access-requests.service.js';
import { HistoryService } from '../documents/history.service.js';
import { IngestionAdminService } from '../ingestion/ingestion-admin.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ProjectScaffoldService } from '../projects/project-scaffold.service.js';
import { BlueprintsService } from '../blueprints/blueprints.service.js';
import { ConnectorProducer } from '../connectors/connector.producer.js';
import { ConnectorsService } from '../connectors/connectors.service.js';
import { ConnectorWorkItemsService } from '../connectors/connector-work-items.service.js';
import { RepoWikiService } from '../connectors/repo-wiki.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AgentLearningsService } from '../ai/agent-learnings.service.js';
import { AccessService } from '../auth/access.service.js';
import { FeaturesService } from '../auth/features.service.js';
import { AiReadableService } from '../ai-readable/ai-readable.service.js';
import { ProvenanceService } from '../feedback/provenance.service.js';
import { AnswerFeedbackService } from '../feedback/answer-feedback.service.js';
import { KnowledgeIssuesService } from '../feedback/knowledge-issues.service.js';
import { VerificationService } from '../verification/verification.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { ShareLinksService } from '../publishing/share-links.service.js';
import { ExportService } from '../export/export.service.js';
import type { Principal } from '../auth/principal.js';
import { FlowsService } from '../flows/flows.service.js';
import { MemosService } from '../memos/memos.service.js';
import { EmbedsService } from '../embeds/embeds.service.js';
import { CaptureService } from '../captures/capture.service.js';
import { ComponentUsagesService } from '../components/component-usages.service.js';
import { ApiSpecDiffService } from '../api-specs/api-spec-diff.service.js';
import { ApiSpecReadService } from '../api-specs/api-spec-read.service.js';
import { ApiFixturesService } from '../api-specs/api-fixtures.service.js';
import { ApiTestSuiteRequestsService } from '../api-specs/api-test-suite-requests.service.js';
import { ApiTestRunsService } from '../api-specs/api-test-runs.service.js';
import { ComponentDraftsService } from '../components/component-drafts.service.js';
import { StyleLintService } from '../assistant/style-lint.service.js';
import { QualityService } from '../quality/quality.service.js';
import { ReleaseTagsService } from '../temporal/release-tags.service.js';
import { TemporalResolverService } from '../temporal/temporal-resolver.service.js';
import { ConflictsService } from '../conflicts/conflicts.service.js';
import { CommunitiesService } from '../communities/communities.service.js';
import { ChatSearchService } from '../chat/chat-search.service.js';
import { AnalyticsRecorder } from '../analytics/analytics.recorder.js';
import { AnalyticsQueryService } from '../analytics/analytics-query.service.js';
import type { Env } from '../config/env.js';

/**
 * The collaborators every MCP tool reaches, and the per-tool guard (#822).
 * `McpService` extends it; the section registrars under `tools/` depend on
 * this class, never on `McpService`, so the registry and its sections import
 * in one direction only.
 */
@Injectable()
export class McpServices {
  constructor(
    readonly prisma: PrismaService,
    readonly storage: StorageService,
    readonly documents: DocumentsService,
    readonly compare: CompareService,
    readonly search: SearchService,
    readonly mergeRequests: MergeRequestsService,
    readonly mergeRequestThreads: MergeRequestThreadsService,
    readonly entities: EntitiesService,
    readonly graph: GraphService,
    readonly graphQuery: GraphQueryService,
    readonly permissions: PermissionService,
    readonly history: HistoryService,
    readonly ingestionAdmin: IngestionAdminService,
    readonly workflows: WorkflowsService,
    readonly projects: ProjectsService,
    readonly connectors: ConnectorsService,
    readonly workItems: ConnectorWorkItemsService,
    readonly connectorProducer: ConnectorProducer,
    readonly agents: AgentRegistryService,
    readonly access: AccessService,
    readonly features: FeaturesService,
    readonly config: ConfigService<Env, true>,
    readonly aiReadable: AiReadableService,
    readonly provenance: ProvenanceService,
    readonly feedback: AnswerFeedbackService,
    readonly issues: KnowledgeIssuesService,
    readonly verification: VerificationService,
    readonly templates: TemplatesService,
    readonly shareLinks: ShareLinksService,
    readonly exports: ExportService,
    readonly repoWiki: RepoWikiService,
    readonly resourceAccess: ResourceAccessService,
    readonly accessRequests: AccessRequestsService,
    readonly learnings: AgentLearningsService,
    readonly captures: CaptureService,
    readonly componentUsages: ComponentUsagesService,
    readonly componentDrafts: ComponentDraftsService,
    readonly apiSpecs: ApiSpecReadService,
    readonly apiDiffs: ApiSpecDiffService,
    readonly styleLint: StyleLintService,
    readonly quality: QualityService,
    readonly temporal: TemporalResolverService,
    readonly releaseTags: ReleaseTagsService,
    readonly conflicts: ConflictsService,
    readonly communities: CommunitiesService,
    readonly analytics: AnalyticsRecorder,
    readonly analyticsQuery: AnalyticsQueryService,
    readonly chatSearch: ChatSearchService,
    readonly handoffs: WorkItemHandoffService,
    readonly flows: FlowsService,
    readonly fixtures: ApiFixturesService,
    readonly testSuites: ApiTestSuiteRequestsService,
    readonly testRuns: ApiTestRunsService,
    readonly embeds: EmbedsService,
    readonly memos: MemosService,
    readonly blueprints: BlueprintsService,
    readonly scaffolds: ProjectScaffoldService,
  ) {}

  webUrl(): string {
    return this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  /**
   * The per-tool twin of AclGuard: resolve the tool's target to its workspace
   * in PG, then the same `requireRole` a REST route runs — key narrowing
   * included. The dev principal skips the lookup exactly as AclGuard does.
   */
  guardFor(principal: Principal) {
    const check = async (resolve: () => Promise<string>, role: WorkspaceRole, operator = false, capture = false) => {
      if (principal.mode === 'dev') return;
      await this.access.requireRole(principal, await resolve(), role, operator, { capture });
    };
    return {
      ws: (workspaceId: string, role: WorkspaceRole, operator = false) =>
        check(() => this.access.workspaceExists(workspaceId), role, operator),
      /**
       * `ws` for a CAPTURE_TOOLS handler (issue #73): the one guard that lets a
       * `capture` key reach editor. Never call it from any other tool.
       */
      captureWs: (workspaceId: string) => check(() => this.access.workspaceExists(workspaceId), 'editor', false, true),
      // A page, its merge request or a project: the same page-level check the
      // REST guard makes (#76), so an MCP client opens exactly what its person can.
      // `doc` and `project` return the workspace they resolved, for a tool that then needs its scope.
      doc: async (id: string, role: WorkspaceRole, capability?: MemberCapability) => {
        const workspaceId = await this.access.workspaceOfDocument(id);
        await this.permissions.requireResource(principal, workspaceId, { type: 'document', id }, role, false, { capability });
        return workspaceId;
      },
      /**
       * After `doc`: the branches and revisions a tool names on that page, held
       * to the same role (#474) — the REST guard's `BRANCH_REFS`, per tool.
       */
      branches: async (documentId: string, refs: BranchRefs, role: WorkspaceRole) =>
        this.permissions.requireBranches(
          principal,
          await this.access.workspaceOfDocument(documentId),
          documentId,
          refs,
          role === 'viewer' ? 'view' : 'edit',
        ),
      /** `doc` at editor for a CAPTURE_TOOLS handler, the page twin of `captureWs`. */
      captureDoc: async (id: string) =>
        this.permissions.requireResource(principal, await this.access.workspaceOfDocument(id), { type: 'document', id }, 'editor', false, {
          capture: true,
        }),
      project: async (id: string, role: WorkspaceRole) => {
        const workspaceId = await this.access.workspaceOfProject(id);
        await this.permissions.requireResource(principal, workspaceId, { type: 'project', id }, role, false);
        return workspaceId;
      },
      /** Returns the merge request's workspace, for a tool that then lists its pages. */
      mr: async (id: string, role: WorkspaceRole) => {
        const { workspaceId, documentId } = await this.access.documentOfMergeRequest(id);
        await this.permissions.requireResource(principal, workspaceId, { type: 'document', id: documentId }, role, false);
        return workspaceId;
      },
      /**
       * The per-tool twin of the REST guard's history rule (#958): call it in
       * every tool that lists or compares revisions, reads one that may not be
       * the current page, or answers as of a point. See `requireHistory`.
       */
      history: (workspaceId: string, documentId?: string, revisionIds?: readonly string[]) =>
        this.permissions.requireHistoryAs(principal, workspaceId, documentId, revisionIds),
      /** The caller's page visibility over a workspace, for tools that list pages. */
      scope: (workspaceId: string) => this.permissions.scopeFor(principal, workspaceId),
      /**
       * A viewer tool whose answer is filtered to what the caller may open, so
       * a guest passes it too and sees only their grants — the twin of
       * `@Access('viewer', …, { guests: true })` (#76). Returns that scope.
       */
      pages: async (workspaceId: string) => {
        if (principal.mode !== 'dev') {
          await this.access.requireRole(principal, await this.access.workspaceExists(workspaceId), 'viewer', false, {
            allowGuest: true,
          });
        }
        return this.permissions.scopeFor(principal, workspaceId);
      },
      // Then the connector's project visibility, as AclGuard does (#555).
      connector: async (id: string, role: WorkspaceRole) => {
        await check(() => this.access.workspaceOf('connector', id), role);
        await this.permissions.requireConnectorVisible(principal, { connectorId: id });
      },
      connectorRun: async (id: string, role: WorkspaceRole) => {
        await check(() => this.access.workspaceOf('connector-run', id), role);
        await this.permissions.requireConnectorVisible(principal, { runId: id });
      },
      // A run is its root page's, as AclGuard resolves it (#1085).
      workflowRun: async (id: string, role: WorkspaceRole) => {
        const { workspaceId, resource } = await this.access.rootOfWorkflowRun(id);
        await this.permissions.requireResource(principal, workspaceId, resource, role, false);
      },
      exportJob: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOf('export', id), role),
      // The workspace only; whether the caller uploaded it is MemosService's 404 (#551).
      memo: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOf('memo', id), role),
    };
  }
}
