import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CAPTURE_KIT_CLIENTS, MCP_LEARNING_TARGET, type CaptureKitClient } from '@knowledge/contracts';
import type { CaptureKitResponse, McpToolSummary, WorkspaceRole } from '@knowledge/contracts';
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
import { t } from '../i18n/t.js';
import { DEV_PRINCIPAL, type Principal } from '../auth/principal.js';
import { CAPTURE_TOOLS, MCP_INSTRUCTIONS, MCP_SERVER_NAME, featureOfTool, isOffered, settleTools, trackTools } from './mcp-tools.js';
import { renderCaptureKit, renderCaptureKitInstaller } from './capture-kit.js';
import { renderMcpLearnings, renderSkill, type McpLearningGroup, type McpWhoami } from './skill.js';
import { registerCaptureTools } from './capture-tools.js';
import { json, type McpToolContext } from './tools/context.js';
import { registerSearchTools } from './tools/search.js';
import { registerPagesTools } from './tools/pages.js';
import { registerWorkspaceTools } from './tools/workspace.js';
import { registerConnectorsTools } from './tools/connectors.js';
import { registerGraphTools } from './tools/graph.js';
import { registerAgentsTools } from './tools/agents.js';
import { registerCodeTools } from './tools/code.js';
import { registerQaTools } from './tools/qa.js';
import { registerDocumentsTools } from './tools/documents.js';
import { registerMergeRequestsTools } from './tools/merge-requests.js';
import { registerResourcesTools } from './tools/resources.js';
import { FlowsService } from '../flows/flows.service.js';
import { MemosService } from '../memos/memos.service.js';
import { EmbedsService } from '../embeds/embeds.service.js';
import { registerDraftTools, type McpDraftTools } from './draft-tools.js';
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
import { AnalyticsRecorder, type AnalyticsCaller } from '../analytics/analytics.recorder.js';
import { AnalyticsQueryService } from '../analytics/analytics-query.service.js';
import type { MemberCapability } from '@knowledge/contracts';
import { PRODUCT_VERSION } from '../config/version.js';

/**
 * MCP tools (plan.md §9). Tool names use underscores (MCP tool names must
 * match [a-zA-Z0-9_-]) but map 1:1 onto the plan's dotted names:
 *
 *   knowledge_search            → knowledge.search            (Phase 1)
 *   knowledge_get_document      → knowledge.get_document      (Phase 1)
 *   knowledge_list_revisions    → knowledge.list_revisions    (Phase 2)
 *   knowledge_compare_revisions → knowledge.compare_revisions (Phase 2)
 *   knowledge_create_branch     → knowledge.create_branch     (Phase 2)
 *   knowledge_create_revision   → knowledge.create_revision   (Phase 2)
 *   knowledge_patch_document    → (#603, line-range edits)
 *   knowledge_find_relations    → knowledge.find_relations    (Phase 4)
 *   knowledge_impact_analysis   → knowledge.impact_analysis   (Phase 4)
 *   knowledge_trace_relation    → knowledge.trace_relation    (Phase 4)
 *   knowledge_code_usages       → where code is used, and the pages documenting it (#236)
 *   knowledge_document_component → draft a component page from code → merge request (#236)
 *   knowledge_list_api_operations → operations of the API specs the caller may open (#78)
 *   knowledge_get_api_operation → one operation's text + the pages linking it (#78)
 *   knowledge_diff_api_spec     → classified spec diff between two revisions (#78)
 *   knowledge_list_test_fixtures → the QA fixture library, by operation or spec (#483)
 *   knowledge_get_test_fixture  → one fixture: steps, the operations it calls, its issues (#483)
 *   knowledge_get_test_suite    → one operation's QA suite, or its bash / Postman export (#468, #483)
 *   knowledge_generate_test_suite → Generate / Regenerate that suite (#468)
 *   knowledge_suggest_test_fixtures → fixtures that could set the suite up, and its bindings (#483)
 *   knowledge_set_test_fixtures → confirm the suite's bindings (#483)
 *   knowledge_get_test_run_plan → the suite as a run plan an agent executes itself (#483)
 *   knowledge_qa_overview       → every operation's QA suite status, worst first (#483)
 *   knowledge_run_test_suite    → run a QA suite on the server against a test environment (#483)
 *   knowledge_get_test_run      → a server run's results, or a suite's recent runs (#483)
 *   knowledge_create_relation   → knowledge.create_relation   (Phase 4, curated)
 *   knowledge_query_graph       → knowledge.query_graph       (Phase 5, audited)
 *   knowledge_get_historical_context → knowledge.get_historical_context (Phase 5)
 *   knowledge_ingest            → knowledge.ingest            (Phase 5)
 *   knowledge_list_projects     → knowledge.list_projects     (projects layer)
 *   knowledge_list_blueprints   → what a new project can start from (#716)
 *   knowledge_scaffold_project  → a project + conventions + pages from a blueprint (#716)
 *   knowledge_get_workspace_graph → knowledge.get_workspace_graph
 *   knowledge_list_workflows    → knowledge.list_workflows    (workflows, feature 17)
 *   knowledge_start_workflow    → knowledge.start_workflow
 *   knowledge_get_workflow_run  → knowledge.get_workflow_run
 *   knowledge_list_connectors   → knowledge.list_connectors   (connectors, feature 19)
 *   knowledge_sync_connector    → knowledge.sync_connector
 *   knowledge_get_connector_run → knowledge.get_connector_run
 *   knowledge_list_agents       → knowledge.list_agents       (agents, feature 20)
 *
 *   knowledge_whoami            → identity, key narrowing, workspaces + projects (feature 33)
 *   knowledge_list_documents    → the page tree of a workspace/project
 *   knowledge_get_document_content → a page's full markdown (read before revising)
 *   knowledge_create_document   → a new page with inline markdown
 *   knowledge_feedback          → rate an answer built from knowledge_search (docs/features/38)
 *   knowledge_report_issue      → report a page as wrong / stale; checked by the sentinel (docs/features/38)
 *   knowledge_lint_draft        → check text against its project's styleguide (#74)
 *   knowledge_get_page_quality  → a page's newest quality score, issues and history (#74)
 *   knowledge_get_page_insights → how often a page is read, by people, the assistant and agents (#79)
 *   knowledge_list_search_gaps  → searches that found nothing or nothing anyone opened (#79)
 *   knowledge_list_memos        → your own memos (recordings) and where each stands (#551)
 *   knowledge_get_memo          → one memo: masked transcript, summary, proposals and drops (#551)
 *
 *   Agent-session memory (issue #73, capture-tools.ts) — writes propose, never publish:
 *   knowledge_capture_decision      → a decision + rationale → merge request (new page or amended page)
 *   knowledge_capture_note          → a gotcha / convention / how-to → merge request
 *   knowledge_propose_glossary_term → a term → the captures inbox, approved by an editor
 *   knowledge_propose_relation      → a frontmatter relation → merge request
 *   knowledge_propose_answer        → a cited answer → merge request
 *   knowledge_find_similar          → the nearest pages by raw cosine, and what a capture would decide
 *   knowledge_list_captures         → captures and where they went
 *
 * Two transports, one tool set (docs/features/33). `buildServer(principal)`
 * binds every tool to a caller: each one runs the same `requireRole` its REST
 * twin's `@Access` does, and every write is attributed to that caller.
 *
 *   stdio (mcp.main.ts)      → DEV_PRINCIPAL: full access, writes attributed to
 *                              the zeros stub. Local process access is the trust.
 *   HTTP  (POST /v1/mcp)     → the bearer's principal, narrowed by its key's
 *                              scope and workspace pin. A read-only key is not
 *                              even offered the write tools.
 */
/**
 * Tools only the API process can serve, passed in by its HTTP controller.
 * The stdio server builds without them (issue #316): it has no collab gateway.
 */
export interface McpExtras {
  drafts?: McpDraftTools;
  /** The HTTP request sent `DNT: 1` or `Sec-GPC: 1` (#79). */
  noTrack?: boolean;
  /**
   * The server instructions with this caller's `mcp` learnings (#305), from
   * `instructionsFor`. Async, so computed by the caller, and only when the
   * request is an `initialize` — the one message that carries instructions.
   */
  instructions?: string;
}


@Injectable()
export class McpService {
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
    readonly config: ConfigService,
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

  async serveStdio(): Promise<void> {
    // ponytail: learnings read once at startup; a learning approved later reaches a restarted stdio server.
    const instructions = await this.instructionsFor(DEV_PRINCIPAL);
    await this.buildServer(DEV_PRINCIPAL, { instructions }).server.connect(new StdioServerTransport());
  }

  /** MCP_INSTRUCTIONS plus the team guidance this caller is given (#305). */
  async instructionsFor(principal: Principal): Promise<string> {
    return MCP_INSTRUCTIONS + renderMcpLearnings(await this.learningsFor(await this.whoami(principal)), 'text');
  }

  /**
   * The active `mcp` learnings (#305, phase 3) for every workspace the caller
   * reaches: workspace-wide ones, and those for a project it may see — only
   * the key's projects when the key is narrowed to some. Learnings for every
   * agent are not included (`everyAgent: false`); the budget and the
   * derived/manual split are the agents' (`choosePromptLearnings`).
   */
  private async learningsFor(whoami: McpWhoami): Promise<McpLearningGroup[]> {
    const pin = whoami.apiKey?.projectIds ?? null;
    const groups = await Promise.all(
      whoami.workspaces.map(async (w) => {
        const projects = pin ? w.projects.filter((p) => pin.includes(p.projectId)) : w.projects;
        const names = new Map(projects.map((p) => [p.projectId, p.name]));
        const rows = await this.learnings.forPrompt({
          workspaceId: w.workspaceId,
          agentKey: MCP_LEARNING_TARGET,
          projectIds: [...names.keys()],
          everyAgent: false,
        });
        return { name: w.name, items: rows.map((l) => ({ text: l.text, project: l.projectId ? (names.get(l.projectId) ?? null) : null })) };
      }),
    );
    return groups.filter((g) => g.items.length > 0);
  }

  /** What `principal` would be offered — the connection page's list and the skill's catalogue. */
  toolsFor(principal: Principal, extras: McpExtras = {}): McpToolSummary[] {
    return this.buildServer(principal, extras).tools;
  }

  /**
   * A server whose every tool acts as `principal`. Cheap enough to build per
   * HTTP request (registration is a map insert per tool), which is what lets
   * the HTTP transport stay stateless: no session to pin a principal to.
   */
  buildServer(principal: Principal, extras: McpExtras = {}): { server: McpServer; tools: McpToolSummary[] } {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: PRODUCT_VERSION },
      { instructions: extras.instructions ?? MCP_INSTRUCTIONS },
    );
    // Every call is filed as `mcp` traffic (#79), whoever the principal is.
    const caller: AnalyticsCaller = { principal, channel: 'mcp', ...(extras.noTrack ? { noTrack: true } : {}) };
    const handles = trackTools(
      server,
      (call) => void this.analytics.toolCall(caller, call),
      (tool, args) => this.featureGate(principal, tool, args),
    );
    const guard = this.guardFor(principal);
    const ctx: McpToolContext = { server, principal, caller, extras, guard, svc: this };
    registerSearchTools(ctx);
    registerPagesTools(ctx);
    registerWorkspaceTools(ctx);
    registerConnectorsTools(ctx);
    registerGraphTools(ctx);
    registerAgentsTools(ctx);
    registerCodeTools(ctx);
    registerQaTools(ctx);
    registerDocumentsTools(ctx);
    registerMergeRequestsTools(ctx);
    registerResourcesTools(ctx);

    registerCaptureTools(server, {
      captures: this.captures,
      flows: this.flows,
      principal,
      guard,
      workspaceOfDocument: (id) => this.access.workspaceOfDocument(id),
      json,
    });

    if (extras.drafts?.enabled) {
      registerDraftTools(server, { drafts: extras.drafts, principal, guard, json });
    }

    return { server, tools: settleTools(handles, principal) };
  }

  /** The SKILL.md for `principal` — see skill.ts. `url` overrides the endpoint it names. */
  async skillFor(principal: Principal, url?: string, extras: McpExtras = {}): Promise<string> {
    const whoami = await this.whoami(principal);
    return renderSkill({
      url: url ?? this.publicUrl(),
      serverName: MCP_SERVER_NAME,
      version: PRODUCT_VERSION,
      authMode: this.config.get('AUTH_MODE') === 'api-key' ? 'api-key' : 'none',
      webUrl: this.webUrl(),
      whoami,
      tools: this.toolsFor(principal, extras),
      learnings: await this.learningsFor(whoami),
      git: this.config.get('GIT_REMOTE_ENABLED') === true,
    });
  }

  /**
   * The capture kit for `client`, generated for `principal` (issue #73) — see
   * capture-kit.ts. Refused to a credential offered no capture tools, whose
   * kit would remind its model to make calls it cannot make.
   */
  async captureKitFor(principal: Principal, client: string): Promise<CaptureKitResponse> {
    if (!(CAPTURE_KIT_CLIENTS as readonly string[]).includes(client)) {
      throw new BadRequestException({
        statusCode: 400,
        message: t('error.capture.kitClient', { client, clients: CAPTURE_KIT_CLIENTS.join(', ') }),
        reason: 'capture-kit-client',
      });
    }
    if (![...CAPTURE_TOOLS].some((name) => isOffered(name, principal))) {
      throw new ForbiddenException({ statusCode: 403, message: t('error.capture.kitNotOffered'), reason: 'capture-not-offered' });
    }
    const whoami = await this.whoami(principal);
    // A capture key pinned to projects captures into those alone, so the kit names no other.
    const pin = whoami.apiKey?.projectIds ?? null;
    return renderCaptureKit({
      client: client as CaptureKitClient,
      url: this.publicUrl(),
      serverName: MCP_SERVER_NAME,
      webUrl: this.webUrl(),
      workspaces: whoami.workspaces.map((w) => ({
        workspaceId: w.workspaceId,
        name: w.name,
        projects: pin ? w.projects.filter((p) => pin.includes(p.projectId)) : w.projects,
      })),
    });
  }

  /** The same kit as a shell script that installs it — `curl … | sh`. */
  async captureKitInstallerFor(principal: Principal, client: string): Promise<string> {
    return renderCaptureKitInstaller(await this.captureKitFor(principal, client), `${this.publicUrl()}/capture-kit/install`);
  }

  webUrl(): string {
    return String(this.config.get('WEB_BASE_URL') ?? 'http://localhost:5173').replace(/\/+$/, '');
  }

  /** `$API_PUBLIC_URL/v1/mcp` — what every generated config points at. */
  publicUrl(): string {
    const base = String(this.config.get('API_PUBLIC_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/v1/mcp`;
  }

  async whoami(principal: Principal): Promise<McpWhoami> {
    // WorkspacesService.list's rule (dev and platform admins see every
    // workspace), read directly: WorkspacesModule carries a controller and so
    // cannot load in the stdio process.
    const pinned = principal.apiKey?.workspaceId ?? null;
    const seesAll = principal.mode === 'dev' || principal.isAdmin;
    const memberships = await this.prisma.workspaceMember.findMany({ where: { userId: principal.userId } });
    const roleOf = new Map(memberships.map((m) => [m.workspaceId, m.role as WorkspaceRole]));
    const ids = pinned ? [pinned] : seesAll ? undefined : [...roleOf.keys()];
    const reachable = await this.prisma.workspace.findMany({
      where: ids ? { id: { in: ids } } : {},
      orderBy: { createdAt: 'asc' },
    });
    const projects = await Promise.all(
      reachable.map(async (w) => {
        // A key pinned to a workspace its person has left reaches no project in it.
        const scope = await this.permissions.scopeFor(principal, w.id).catch(() => null);
        return scope ? this.projects.list({ workspaceId: w.id }, scope) : { projects: [], nextCursor: null };
      }),
    );
    // A capture key proposes, it does not edit (issue #73): viewer is what it may do with a page.
    const readOnly = principal.apiKey !== undefined && principal.apiKey.scope !== 'write';
    return {
      userId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      mode: principal.mode,
      apiKey: principal.apiKey
        ? {
            scope: principal.apiKey.scope,
            workspaceId: principal.apiKey.workspaceId,
            projectIds: principal.apiKey.projectIds?.length ? principal.apiKey.projectIds : null,
          }
        : null,
      workspaces: reachable
        // A key pinned to a workspace its owner has since left reaches nothing.
        .filter((w) => seesAll || roleOf.has(w.id))
        .map((w) => {
          const role = roleOf.get(w.id) ?? 'admin';
          // A guest reads only what is granted to them (#76), so the workspace's
          // project names are not theirs to list, and a read-only key cannot
          // lift them to viewer.
          const guest = role === 'guest';
          return {
            workspaceId: w.id,
            name: w.name,
            // What this connection may actually do, not merely the membership
            // row: a read-only key caps it, and dev/platform admin has no row.
            role: readOnly && !guest ? 'viewer' : role,
            projects: guest
              ? []
              : projects[reachable.indexOf(w)].projects.map((p) => ({ projectId: p.projectId, name: p.name })),
          };
        }),
    };
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
      workflowRun: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOf('workflow-run', id), role),
      exportJob: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOf('export', id), role),
      // The workspace only; whether the caller uploaded it is MemosService's 404 (#551).
      memo: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOf('memo', id), role),
    };
  }

  /**
   * #604: refuse a tool of a section its workspace switched off, as `@Feature`
   * refuses the REST twin. Membership first, as AclGuard orders it, so the 404
   * tells only a member that the section is off.
   */
  private async featureGate(principal: Principal, tool: string, args: Record<string, unknown>): Promise<void> {
    const feature = featureOfTool(tool);
    if (!feature) return;
    const id = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : null);
    const documentId = id('documentId');
    const runId = tool === 'knowledge_get_workflow_run' ? id('runId') : null;
    const workspaceId =
      id('workspaceId') ??
      (documentId ? await this.access.workspaceOfDocument(documentId) : null) ??
      (runId ? await this.access.workspaceOf('workflow-run', runId) : null);
    if (!workspaceId) return;
    await this.access.requireRole(principal, workspaceId, 'viewer', false, { allowGuest: true });
    await this.features.require(workspaceId, feature);
  }
}
