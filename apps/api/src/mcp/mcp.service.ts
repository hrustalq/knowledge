import { Injectable } from '@nestjs/common';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ANSWER_FEEDBACK_REASONS,
  ANSWER_RATINGS,
  DOCUMENT_CATEGORIES,
  KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS,
  KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS,
  KNOWLEDGE_ISSUE_EVIDENCE_MAX,
  KNOWLEDGE_ISSUE_KINDS,
  KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS,
  VERIFICATION_FLAGS,
  AGENT_LEARNING_MAX_CHARS,
  AGENT_LEARNING_STATUSES,
  EXPORT_FORMATS,
  SHARE_PASSWORD_MAX_CHARS,
  SHARE_PASSWORD_MIN_CHARS,
  VERIFICATION_NOTE_MAX_CHARS,
  WIKI_SECTIONS,
  REQUESTABLE_ACCESS_LEVELS,
} from '@knowledge/contracts';
import type { AiAgentChoice, McpToolSummary, WorkspaceRole } from '@knowledge/contracts';
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
import { AuditService } from '../auth/audit.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ResourceAccessService } from '../permissions/resource-access.service.js';
import { AccessRequestsService } from '../permissions/access-requests.service.js';
import { HistoryService } from '../documents/history.service.js';
import { IngestionAdminService } from '../ingestion/ingestion-admin.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ConnectorProducer } from '../connectors/connector.producer.js';
import { ConnectorsService, toRunInfo } from '../connectors/connectors.service.js';
import { ConnectorWorkItemsService } from '../connectors/connector-work-items.service.js';
import { RepoWikiService } from '../connectors/repo-wiki.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AgentLearningsService } from '../ai/agent-learnings.service.js';
import { AccessService } from '../auth/access.service.js';
import { AiReadableService } from '../ai-readable/ai-readable.service.js';
import { ProvenanceService } from '../feedback/provenance.service.js';
import { AnswerFeedbackService } from '../feedback/answer-feedback.service.js';
import { KnowledgeIssuesService } from '../feedback/knowledge-issues.service.js';
import { VerificationService } from '../verification/verification.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { ShareLinksService } from '../publishing/share-links.service.js';
import { ExportService } from '../export/export.service.js';
import { currentTrace, newTraceId } from '@knowledge/observability';
import { keepFrontmatter } from '../common/frontmatter.js';
import { DEV_PRINCIPAL, type Principal } from '../auth/principal.js';
import { MCP_INSTRUCTIONS, MCP_SERVER_NAME, settleTools, trackTools } from './mcp-tools.js';
import { renderSkill, type McpWhoami } from './skill.js';
import { registerCaptureTools } from './capture-tools.js';
import { CaptureService } from '../captures/capture.service.js';

/**
 * Bumped by hand at every release, with swagger.ts (docs/versioning.md#known-drift).
 * Named because the connection page and the skill report it too.
 */
export const MCP_SERVER_VERSION = '0.23.0';

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
 *   knowledge_find_relations    → knowledge.find_relations    (Phase 4)
 *   knowledge_impact_analysis   → knowledge.impact_analysis   (Phase 4)
 *   knowledge_trace_relation    → knowledge.trace_relation    (Phase 4)
 *   knowledge_create_relation   → knowledge.create_relation   (Phase 4, curated)
 *   knowledge_query_graph       → knowledge.query_graph       (Phase 5, audited)
 *   knowledge_get_historical_context → knowledge.get_historical_context (Phase 5)
 *   knowledge_ingest            → knowledge.ingest            (Phase 5)
 *   knowledge_list_projects     → knowledge.list_projects     (projects layer)
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
 *
 *   Agent-session memory (issue #73, capture-tools.ts) — writes propose, never publish:
 *   knowledge_capture_decision      → a decision + rationale → merge request (new page or amended page)
 *   knowledge_capture_note          → a gotcha / convention / how-to → merge request
 *   knowledge_propose_glossary_term → a term → the captures inbox, approved by an editor
 *   knowledge_propose_relation      → a frontmatter relation → merge request
 *   knowledge_propose_answer        → a cited answer → merge request
 *   knowledge_find_similar          → the nearest pages by raw cosine, before capturing
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
@Injectable()
export class McpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
    private readonly compare: CompareService,
    private readonly search: SearchService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly mergeRequestThreads: MergeRequestThreadsService,
    private readonly entities: EntitiesService,
    private readonly graph: GraphService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly history: HistoryService,
    private readonly ingestionAdmin: IngestionAdminService,
    private readonly workflows: WorkflowsService,
    private readonly projects: ProjectsService,
    private readonly connectors: ConnectorsService,
    private readonly workItems: ConnectorWorkItemsService,
    private readonly connectorProducer: ConnectorProducer,
    private readonly agents: AgentRegistryService,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly aiReadable: AiReadableService,
    private readonly provenance: ProvenanceService,
    private readonly feedback: AnswerFeedbackService,
    private readonly issues: KnowledgeIssuesService,
    private readonly verification: VerificationService,
    private readonly templates: TemplatesService,
    private readonly shareLinks: ShareLinksService,
    private readonly exports: ExportService,
    private readonly repoWiki: RepoWikiService,
    private readonly resourceAccess: ResourceAccessService,
    private readonly accessRequests: AccessRequestsService,
    private readonly learnings: AgentLearningsService,
    private readonly captures: CaptureService,
  ) {}

  async serveStdio(): Promise<void> {
    await this.buildServer(DEV_PRINCIPAL).server.connect(new StdioServerTransport());
  }

  /** What `principal` would be offered — the connection page's list and the skill's catalogue. */
  toolsFor(principal: Principal): McpToolSummary[] {
    return this.buildServer(principal).tools;
  }

  /**
   * A server whose every tool acts as `principal`. Cheap enough to build per
   * HTTP request (registration is a map insert per tool), which is what lets
   * the HTTP transport stay stateless: no session to pin a principal to.
   */
  buildServer(principal: Principal): { server: McpServer; tools: McpToolSummary[] } {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { instructions: MCP_INSTRUCTIONS },
    );
    const handles = trackTools(server);
    const guard = this.guardFor(principal);

    server.registerTool(
      'knowledge_search',
      {
        description:
          'Semantic search over the knowledge base. Every result carries document/revision/chunk citations plus ' +
          'provenance: revisionNumber, changedAt (freshness), authorName, verification / trust.status (verified | ' +
          'expired | edited | requested | outdated | flagged | unverified), trust.inactive, trust.ownerId and ' +
          'factClass. Ranking already favours verified pages and demotes outdated ones; still say when a page you ' +
          'relied on is outdated, expired or edited since verification. Archived pages are absent unless ' +
          'includeArchived is true. The response traceId identifies this search.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          query: z.string().min(1),
          limit: z.number().int().min(1).max(100).optional(),
          projectIds: z
            .array(z.string().uuid())
            .max(20)
            .optional()
            .describe('Restrict results to these projects (see knowledge_list_projects)'),
          tags: z
            .array(z.string())
            .max(20)
            .optional()
            .describe(
              'Restrict results to documents carrying ANY of these frontmatter tags ("security" or "tag:security")',
            ),
          includeArchived: z.boolean().optional().describe('Also return archived pages (default false)'),
        },
      },
      async ({ workspaceId, query, limit, projectIds, tags, includeArchived }) => {
        const scope = await guard.pages(workspaceId);
        // One merged object: separate spreads would clobber each other.
        const filters = {
          ...(projectIds?.length ? { projectIds } : {}),
          ...(tags?.length ? { tags } : {}),
          ...(includeArchived ? { includeArchived: true } : {}),
        };
        const res = await this.search.search(
          {
            workspaceId,
            query,
            limit: limit ?? 20,
            ...(Object.keys(filters).length ? { filters } : {}),
          },
          scope,
        );
        // One batched read for the whole hit list (docs/features/38), and the
        // trace id of this call so an agent can quote it back to
        // knowledge_feedback.
        return this.json({
          ...res,
          results: await this.provenance.decorateResults(workspaceId, res.results),
          traceId: currentTrace()?.traceId ?? newTraceId(),
        });
      },
    );

    server.registerTool(
      'knowledge_feedback',
      {
        description:
          'Rate an answer you built from knowledge_search: up or down, with a reason on down. Quote the search\'s ' +
          'traceId so a re-vote updates the same row. Votes and reasons are what turns a bad answer into ' +
          'documentation work; nothing else changes.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          rating: z.enum(ANSWER_RATINGS),
          reason: z.enum(ANSWER_FEEDBACK_REASONS).optional().describe('Required when rating is "down"'),
          comment: z.string().max(2000).optional(),
          query: z.string().min(1).max(4000).describe('The question the answer was for'),
          traceId: z.string().max(64).optional().describe('traceId from the knowledge_search response'),
          documentIds: z.array(z.string().uuid()).max(20).optional().describe('Pages the answer cited'),
        },
      },
      async ({ workspaceId, rating, reason, comment, query, traceId, documentIds }) => {
        await guard.ws(workspaceId, 'viewer');
        if (rating === 'down' && !reason) throw new Error('A "down" rating needs a reason.');
        const res = await this.feedback.voteOverMcp(
          {
            workspaceId,
            rating,
            ...(reason ? { reason } : {}),
            ...(comment ? { comment } : {}),
            query,
            ...(traceId ? { traceId } : {}),
            ...(documentIds?.length ? { documentIds } : {}),
          },
          principal,
        );
        return this.json({ feedbackId: res.feedback.id, surface: res.feedback.surface, deduplicated: res.deduplicated });
      },
    );

    server.registerTool(
      'knowledge_report_issue',
      {
        description:
          'Report that a page is wrong, out of date, missing something, or a duplicate. Quote the passage and say ' +
          'where the correct information is. The report is checked by the sentinel and may become a merge request ' +
          'for a person to review; a second report of the same page and kind folds into the open one. Returns the ' +
          'issue, its status (open | checking | proposed) and whether it was deduplicated.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          documentId: z.string().uuid(),
          revisionId: z.string().uuid().optional().describe('The revision you read, from knowledge_search or get_document'),
          kind: z.enum(KNOWLEDGE_ISSUE_KINDS),
          detail: z.string().min(1).max(KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS).describe('What is wrong, in plain words'),
          evidence: z
            .array(
              z.object({
                quote: z.string().max(KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS).optional().describe('The passage disputed'),
                url: z.string().max(KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS).optional().describe('Where the correct information is'),
                note: z.string().max(KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS).optional(),
              }),
            )
            .max(KNOWLEDGE_ISSUE_EVIDENCE_MAX)
            .optional(),
          suggestedMarkdown: z
            .string()
            .max(KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS)
            .optional()
            .describe('A corrected page body without frontmatter. From an editor key it opens a draft merge request at once.'),
        },
      },
      async ({ workspaceId, documentId, revisionId, kind, detail, evidence, suggestedMarkdown }) => {
        await guard.doc(documentId, 'viewer');
        const res = await this.issues.report(
          {
            workspaceId,
            documentId,
            ...(revisionId ? { revisionId } : {}),
            kind,
            detail,
            ...(evidence?.length ? { evidence } : {}),
            ...(suggestedMarkdown ? { suggestedMarkdown } : {}),
            surface: 'mcp',
          },
          principal,
        );
        return this.json({
          issueId: res.issue.id,
          status: res.issue.status,
          deduplicated: res.deduplicated,
          reportCount: res.issue.reportCount,
          ...(res.issue.mergeRequestId ? { mergeRequestId: res.issue.mergeRequestId } : {}),
          ...(res.issue.agentRunId ? { agentRunId: res.issue.agentRunId } : {}),
        });
      },
    );

    server.registerTool(
      'knowledge_flag_document',
      {
        description:
          'Set a page\'s declared verification state (docs/features/39): "requested" asks its owner to check it ' +
          '(any member), "outdated" declares it wrong (editor) and ranks it last in search until a person verifies ' +
          'or clears it. Give a note saying why. Verifying is a person\'s act and has no tool. For a problem with ' +
          'evidence that should be checked and fixed, prefer knowledge_report_issue.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          documentId: z.string().uuid(),
          state: z.enum(VERIFICATION_FLAGS),
          note: z.string().max(VERIFICATION_NOTE_MAX_CHARS).optional().describe('Why, in plain words — shown on the page'),
        },
      },
      async ({ workspaceId, documentId, state, note }) => {
        // The REST twins: `verification-request` is viewer, `outdated` is editor.
        await guard.doc(documentId, state === 'outdated' ? 'editor' : 'viewer');
        const res = await this.verification.flag(documentId, state, {
          actorId: principal.userId,
          ...(note ? { note } : {}),
          source: { kind: 'mcp', by: principal.userId },
        });
        const doc = res?.document;
        return this.json({
          documentId,
          workspaceId,
          state,
          verification: doc?.verification ?? state,
          ownerId: doc?.ownerId ?? null,
        });
      },
    );

    server.registerTool(
      'knowledge_share_page',
      {
        description:
          'Create a public, read-only link to a page (docs/features/43) that anyone with the URL can open without ' +
          'signing in — only when a person asked for one. includeSubtree also shares every page under it. Without ' +
          'expiresInDays the link never expires, which most workspaces only allow with a password. Fails with 403 ' +
          'when the workspace has sharing switched off. Returns the URL; revoke it from the page\'s Share menu.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          documentId: z.string().uuid(),
          includeSubtree: z.boolean().optional(),
          expiresInDays: z.number().int().min(1).max(3650).optional(),
          password: z.string().min(SHARE_PASSWORD_MIN_CHARS).max(SHARE_PASSWORD_MAX_CHARS).optional(),
        },
      },
      async ({ workspaceId, documentId, includeSubtree, expiresInDays, password }) => {
        // The REST twin is POST /v1/documents/:id/shares, editor.
        await guard.doc(documentId, 'editor');
        const res = await this.shareLinks.create(
          documentId,
          {
            includeSubtree: includeSubtree ?? false,
            expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null,
            ...(password ? { password } : {}),
          },
          principal.userId,
        );
        return this.json({
          workspaceId,
          documentId,
          shareId: res.share.id,
          url: res.url,
          includeSubtree: res.share.includeSubtree,
          expiresAt: res.share.expiresAt,
          hasPassword: res.share.hasPassword,
        });
      },
    );

    server.registerTool(
      'knowledge_export',
      {
        description:
          'Export a page, a page and its subpages, or a whole project as a file a person can download ' +
          '(docs/features/45): zip (markdown sources with frontmatter, attachments and manifest.json), html (an ' +
          'offline site, zipped) or pdf (only where the deployment has Gotenberg). Give documentId, or projectId for ' +
          'a whole project. Runs in the background: returns the export id — poll knowledge_get_export for the ' +
          'download URL.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          format: z.enum(EXPORT_FORMATS),
          documentId: z.string().uuid().optional(),
          includeSubtree: z.boolean().optional().describe('With documentId: also export every page under it'),
          projectId: z.string().uuid().optional().describe('Export every page of this project instead of one page'),
          branch: z.string().max(100).optional().describe('Branch to read each page from; default branches when omitted'),
        },
      },
      async ({ workspaceId, format, documentId, includeSubtree, projectId, branch }) => {
        // The REST twins are POST /v1/documents/:id/exports and
        // POST /v1/projects/:id/exports, both viewer.
        if (!documentId === !projectId) throw new Error('Give exactly one of documentId or projectId');
        let job;
        if (documentId) {
          await guard.doc(documentId, 'viewer');
          job = await this.exports.createForDocument(documentId, { format, includeSubtree, branch }, principal);
        } else {
          await guard.project(projectId!, 'viewer');
          job = await this.exports.createForProject(projectId!, { format, branch }, principal);
        }
        return this.json({ workspaceId, exportId: job.id, status: job.status, format: job.format, scope: job.scope });
      },
    );

    server.registerTool(
      'knowledge_get_export',
      {
        description:
          'One export: its status (queued | running | completed | failed | expired), page count and size, and — once ' +
          'completed — a download URL valid for a few minutes. Only the person who asked for it, or an admin, sees it.',
        inputSchema: { workspaceId: z.string().uuid(), exportId: z.string().uuid() },
      },
      async ({ exportId }) => {
        // The REST twins are GET /v1/exports/:id and /download, both viewer.
        await guard.exportJob(exportId, 'viewer');
        const job = await this.exports.get(exportId, principal);
        const download = job.status === 'completed' ? await this.exports.download(exportId, principal) : null;
        return this.json({ ...job, download });
      },
    );

    server.registerTool(
      'knowledge_list_projects',
      {
        description:
          'List the projects in a workspace. Workspace > Project > Document — every document belongs to exactly one project.',
        inputSchema: { workspaceId: z.string().uuid() },
      },
      async ({ workspaceId }) => {
        return this.json(await this.projects.list({ workspaceId }, await guard.pages(workspaceId)));
      },
    );

    server.registerTool(
      'knowledge_list_connectors',
      {
        description:
          'List the external systems this workspace syncs with (Confluence, Jira, Notion, markdown/git). Each entry says which direction it moves content, how many pages it has claimed, and how its last sync went.',
        inputSchema: { workspaceId: z.string().uuid() },
      },
      async ({ workspaceId }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(await this.connectors.list(workspaceId));
      },
    );

    server.registerTool(
      'knowledge_sync_connector',
      {
        description:
          'Start a sync run for one connector and return the run to poll with knowledge_get_connector_run. Pulling is idempotent: unchanged items are skipped, and an item changed on both sides opens a merge request rather than overwriting anything.',
        inputSchema: {
          connectorId: z.string().uuid(),
          direction: z
            .enum(['pull', 'push'])
            .optional()
            .describe("Defaults to 'pull' — bring external content in."),
          externalIds: z
            .array(z.string())
            .max(500)
            .optional()
            .describe('Limit the run to these external items; omit to sync the whole scope.'),
        },
      },
      async ({ connectorId, direction, externalIds }) => {
        await guard.connector(connectorId, 'editor');
        const row = await this.connectors.require(connectorId);
        const run = await this.connectors.createRun(row, direction ?? 'pull', 'manual', { externalIds });
        await this.connectorProducer.enqueue(run.id);
        return this.json(toRunInfo(run));
      },
    );

    server.registerTool(
      'knowledge_get_connector_run',
      {
        description:
          'One sync run: status, current stage, and how many pages were created, updated, skipped, failed or left as conflicts. Warnings list what a run could not carry.',
        inputSchema: { runId: z.string().uuid() },
      },
      async ({ runId }) => {
        await guard.connectorRun(runId, 'viewer');
        return this.json(await this.connectors.getRun(runId));
      },
    );

    // Repo wiki (docs/features/46). The read mirrors `GET :id/wiki`; the write
    // mirrors `POST :id/wiki/regenerate` and, like `knowledge_sync_connector`,
    // only queues a run — the pages are written by the worker, reviewed by
    // the connector's own rules.
    server.registerTool(
      'knowledge_repo_wiki',
      {
        description:
          "A codebase connector's repo wiki: its sections and the page each one is, which are stale or waiting in a merge request, and how the repository's .knowledge/wiki.yml steers it — effort asked beside effort applied. Read it before writing about a repository's architecture: the wiki is derived from the code.",
        inputSchema: { connectorId: z.string().uuid() },
      },
      async ({ connectorId }) => {
        await guard.connector(connectorId, 'viewer');
        return this.json(await this.repoWiki.info(connectorId));
      },
    );

    server.registerTool(
      'knowledge_regenerate_wiki',
      {
        description:
          "Queue a run that re-derives a codebase connector's repo wiki, or only some sections. Only pages whose code changed are rewritten unless force is set. Returns the run to poll with knowledge_get_connector_run.",
        inputSchema: {
          connectorId: z.string().uuid(),
          sections: z
            .array(z.enum(WIKI_SECTIONS))
            .max(WIKI_SECTIONS.length)
            .optional()
            .describe('Only these sections; omit for the whole wiki.'),
          force: z.boolean().optional().describe('Re-derive even pages whose inputs did not change. Defaults to false.'),
        },
      },
      async ({ connectorId, sections, force }) => {
        await guard.connector(connectorId, 'editor');
        const run = await this.repoWiki.regenerate(connectorId, { sections, force, actorId: principal.userId });
        await this.connectorProducer.enqueue(run.id);
        return this.json(toRunInfo(run));
      },
    );

    // Work items (docs/features/32). Reading only: opening an issue is an act
    // attributed to a person, and on stdio that person is the anonymous stub —
    // the same reason workflow approval is deliberately absent from this surface.
    server.registerTool(
      'knowledge_list_work_items',
      {
        description:
          'Issues and pull requests on a connected repository, with the page each one is attached to. Use it to find out what work is open against something before writing about it. A "merged" pull request finished; a "closed" one was abandoned.',
        inputSchema: {
          connectorId: z.string().uuid(),
          state: z
            .enum(['open', 'closed', 'all'])
            .optional()
            .describe("Defaults to 'all'; 'closed' includes merged."),
        },
      },
      async ({ connectorId, state }) => {
        await guard.connector(connectorId, 'viewer');
        const row = await this.connectors.require(connectorId);
        const items = await this.workItems.list(row);
        const wanted = state ?? 'all';
        return this.json(
          items.filter((item) =>
            wanted === 'all' ? true : wanted === 'closed' ? item.state !== 'open' : item.state === 'open',
          ),
        );
      },
    );

    server.registerTool(
      'knowledge_get_workspace_graph',
      {
        description:
          'The whole workspace (or one project) as a single relation graph: every document as a node, every entity it references, and the typed edges between them with provenance. Use this for an overview of how a knowledge base hangs together — or to find orphan pages, which appear with degree 0. For one page\'s neighbourhood use knowledge_find_relations instead.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          projectId: z.string().uuid().optional().describe('Restrict the graph to one project'),
        },
      },
      async ({ workspaceId, projectId }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(await this.documents.getWorkspaceGraph(await guard.scope(workspaceId), projectId));
      },
    );

    // ------------------------------------------------------------ learnings
    // Team guidance (#70). Reading the approved list is how an external coding
    // agent picks up what this team has taught its agents; proposing is open to
    // editors, and only an admin, in the app, makes a proposal active.
    server.registerTool(
      'knowledge_list_agent_learnings',
      {
        description:
          'Corrections this team taught its agents ("learnings"), newest first. Active ones are approved by an admin ' +
          'and are what the platform\'s own agents are told — follow them when you do the same kind of work. ' +
          'Pass agentKey for one agent\'s list (it includes learnings for every agent).',
        inputSchema: {
          workspaceId: z.string().uuid(),
          agentKey: z.string().max(64).optional().describe('e.g. reviewer, curator'),
          status: z.enum(AGENT_LEARNING_STATUSES).optional().describe('Defaults to active'),
        },
      },
      async ({ workspaceId, agentKey, status }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json({
          learnings: await this.learnings.list(workspaceId, { status: status ?? 'active', ...(agentKey ? { agentKey } : {}) }),
        });
      },
    );

    server.registerTool(
      'knowledge_propose_agent_learning',
      {
        description:
          'Propose a learning: a correction for one agent (or every agent), in plain words. It is stored as ' +
          'proposed and reaches no prompt until a workspace admin approves it in the app.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          text: z.string().min(1).max(AGENT_LEARNING_MAX_CHARS),
          agentKey: z.string().max(64).optional().describe('The agent it teaches; omit for every agent'),
          projectId: z.string().uuid().optional().describe('Applies only in this project'),
        },
      },
      async ({ workspaceId, text, agentKey, projectId }) => {
        // The REST twin is `@Access('editor', 'body')`; the proposed status is
        // fixed here, so no key — whatever its owner's role — can make one active.
        await guard.ws(workspaceId, 'editor');
        return this.json(
          await this.learnings.create(
            { workspaceId, text, agentKey: agentKey ?? null, projectId: projectId ?? null, status: 'proposed', sourceKind: 'manual' },
            principal.userId,
          ),
        );
      },
    );

    // ------------------------------------------------------------ workflows
    // Dynamic document workflows (docs/features/17). Starting a run is exposed
    // but approving one is not: approval publishes pages, and an agent should
    // not be the thing that decides what gets published — over HTTP it has a
    // principal, but it is still not the person. It can kick a chain off and
    // watch it; a person approves.
    server.registerTool(
      'knowledge_list_workflows',
      {
        description:
          'List workflow definitions in a workspace: configurable step chains (entity → use-cases → API endpoints + pages) that can be run against a page.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          projectId: z.string().uuid().optional().describe('Adds this project\'s definitions to the workspace-wide ones'),
        },
      },
      async ({ workspaceId, projectId }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(await this.workflows.list({ workspaceId, ...(projectId ? { projectId } : {}) }));
      },
    );

    server.registerTool(
      'knowledge_start_workflow',
      {
        description:
          'Start a workflow run against a source page. Returns immediately — the run executes in the background and parks at its first review gate. 409 when a run of the same workflow is already in flight for that page.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          definitionId: z.string().uuid().describe('From knowledge_list_workflows'),
          rootDocumentId: z.string().uuid().describe('The page the chain starts from'),
          note: z.string().max(4000).optional().describe('Extra instructions for this run only'),
        },
      },
      async ({ workspaceId, definitionId, rootDocumentId, note }) => {
        await guard.ws(workspaceId, 'editor');
        await guard.doc(rootDocumentId, 'editor');
        return this.json(
            await this.workflows.startRun(
              { workspaceId, definitionId, rootDocumentId, ...(note ? { note } : {}) },
              principal.userId,
              'mcp',
            ),
          );
      },
    );

    server.registerTool(
      'knowledge_list_agents',
      {
        description:
          "The named actors behind this workspace's AI calls (feature 20): which agents exist, what each is for, " +
          'and whether it is enabled. Read-only — names and descriptions only, never prompts, tool lists or ' +
          'provider endpoints.',
        inputSchema: { workspaceId: z.string().uuid() },
      },
      async ({ workspaceId }) => {
        await guard.ws(workspaceId, 'viewer');
        const agents = await this.agents.list(workspaceId);
        return this.json({
          agents: agents
            .filter((agent) => agent.enabled)
            .map(
              (agent): AiAgentChoice => ({ key: agent.key, name: agent.name, description: agent.description }),
            ),
        });
      },
    );

    // There is deliberately no knowledge_run_agent. A background run stores
    // `created_by` NOT NULL precisely so it always has an owner to authorise
    // and bill as, and the stdio transport runs as the anonymous stub. The two
    // transports offer one tool set, so the tool is absent from both. Runs
    // begin from the Agents tab or from a schedule, both of which name a real
    // user. (docs/features/20-agents-todo.md item 3.)

    server.registerTool(
      'knowledge_get_workflow_run',
      {
        description:
          'A workflow run with its frozen step graph and its node tree — every intermediate result, including drafts still awaiting review.',
        inputSchema: { runId: z.string().uuid() },
      },
      async ({ runId }) => {
        await guard.workflowRun(runId, 'viewer');
        return this.json(await this.workflows.getRun(runId));
      },
    );

    server.registerTool(
      'knowledge_find_relations',
      {
        description:
          'Neighborhood of an entity: documents referencing it (with relation type, fact class, confidence) and entities within N hops.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          entity: z.string().min(1).describe('Entity key, e.g. "service:identity"'),
          relationship: z.string().optional().describe('Filter to one relation type, e.g. DEPENDS_ON'),
          depth: z.number().int().min(1).max(3).optional(),
        },
      },
      async ({ workspaceId, entity, relationship, depth }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(
            await this.entities.neighbors(await guard.scope(workspaceId), entity, depth ?? 1, relationship ? [relationship] : undefined),
          );
      },
    );

    server.registerTool(
      'knowledge_impact_analysis',
      {
        description:
          'Transitive impact of changing an entity: dependents (what breaks) or dependencies (what it relies on), with document evidence paths.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          entityId: z.string().min(1).describe('Entity key, e.g. "service:identity"'),
          direction: z.enum(['dependents', 'dependencies']).optional(),
          maxDepth: z.number().int().min(1).max(5).optional(),
        },
      },
      async ({ workspaceId, entityId, direction, maxDepth }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(await this.entities.impactAnalysis(await guard.scope(workspaceId), entityId, direction ?? 'dependents', maxDepth ?? 3));
      },
    );

    server.registerTool(
      'knowledge_trace_relation',
      {
        description: 'Shortest relation path between two entities, alternating entity/document steps with edge types.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          fromEntityId: z.string().min(1),
          toEntityId: z.string().min(1),
          maxDepth: z.number().int().min(1).max(6).optional(),
        },
      },
      async ({ workspaceId, fromEntityId, toEntityId, maxDepth }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(await this.entities.trace(await guard.scope(workspaceId), fromEntityId, toEntityId, maxDepth ?? 4));
      },
    );

    server.registerTool(
      'knowledge_get_document',
      {
        description: 'Get a document, its head (or a given) revision and indexed chunk summaries.',
        inputSchema: {
          documentId: z.string().uuid(),
          revisionId: z.string().uuid().optional(),
        },
      },
      async ({ documentId, revisionId }) => {
        await guard.doc(documentId, 'viewer');
        return this.json(await this.documents.getDocument(documentId, revisionId));
      },
    );

    // Read-only (#76): why a page is or is not open to this caller. Grant
    // management stays out of MCP — a restriction is a person's decision.
    server.registerTool(
      'knowledge_get_page_access',
      {
        description:
          'The restrictions on a page as they apply to you: whether it is restricted itself, the restricted pages and ' +
          'project above it, and your effective level (view | edit | manage). Grants are listed only when you may ' +
          'manage the page. Use it when a write is refused, or before telling someone a page is visible to a team.',
        inputSchema: { documentId: z.string().uuid() },
      },
      async ({ documentId }) => {
        await guard.doc(documentId, 'viewer');
        return this.json(await this.resourceAccess.get(principal, { type: 'document', id: documentId }));
      },
    );

    // A write (#76, phase 5): files a request the page's managers are told
    // about. Guests pass the workspace gate (`guard.pages`) and are refused
    // by the service exactly as REST refuses them — a 404 for a page they
    // cannot open, so asking is not a way to learn that one exists.
    server.registerTool(
      'knowledge_request_access',
      {
        description:
          'Ask for view or edit access to a page you were refused. Its managers and the workspace admins are notified, ' +
          'and you are told when they decide. Only when a person asked for it: the request is sent in their name. ' +
          'Refused with 409 when you already have that level or already asked.',
        inputSchema: {
          documentId: z.string().uuid(),
          level: z.enum(REQUESTABLE_ACCESS_LEVELS),
          message: z.string().max(1000).optional().describe('Why the access is needed, shown to the managers'),
        },
      },
      async ({ documentId, level, message }) => {
        const workspaceId = await this.access.workspaceOfDocument(documentId);
        await guard.pages(workspaceId);
        return this.json(
          await this.accessRequests.create(principal, {
            workspaceId,
            resourceType: 'document',
            resourceId: documentId,
            level,
            message: message ?? null,
          }),
        );
      },
    );

    // The whole page, as its author wrote it. get_document answers "what is
    // this page and is it indexed"; editing needs the text itself, because a
    // revision is the full document and never a patch.
    server.registerTool(
      'knowledge_get_document_content',
      {
        description:
          'The full markdown (and parsed frontmatter) of a document at its default-branch head or a given revision. Read this before writing a revision: a revision replaces the whole page. ' +
          '`markdown` is the body without its frontmatter block; posting it back as-is keeps the frontmatter.',
        inputSchema: {
          documentId: z.string().uuid(),
          revisionId: z.string().uuid().optional(),
        },
      },
      async ({ documentId, revisionId }) => {
        await guard.doc(documentId, 'viewer');
        return this.json(await this.documents.getContent(documentId, revisionId));
      },
    );

    server.registerTool(
      'knowledge_list_revisions',
      {
        description: 'List the immutable revision DAG of a document (parent ids, branch, status).',
        inputSchema: {
          documentId: z.string().uuid(),
          branch: z.string().optional(),
        },
      },
      async ({ documentId, branch }) => {
        await guard.doc(documentId, 'viewer');
        return this.json(await this.documents.listRevisions(documentId, branch));
      },
    );

    server.registerTool(
      'knowledge_compare_revisions',
      {
        description:
          'GitLab-style comparison of two revisions: "direct" (diff from..to) or "merge-base" (diff from...to against the nearest common ancestor).',
        inputSchema: {
          documentId: z.string().uuid(),
          fromRevisionId: z.string().uuid(),
          toRevisionId: z.string().uuid(),
          mode: z.enum(['direct', 'merge-base']).optional(),
          includeSemanticDiff: z.boolean().optional(),
        },
      },
      async ({ documentId, fromRevisionId, toRevisionId, mode, includeSemanticDiff }) => {
        await guard.doc(documentId, 'viewer');
        return this.json(
            await this.compare.compare(documentId, fromRevisionId, toRevisionId, mode ?? 'direct', {
              structural: true,
              semantic: includeSemanticDiff ?? false,
            }),
          );
      },
    );

    server.registerTool(
      'knowledge_create_branch',
      {
        description: 'Create a branch on a document, from a given revision or the default-branch head.',
        inputSchema: {
          documentId: z.string().uuid(),
          name: z.string().min(1),
          fromRevisionId: z.string().uuid().optional(),
        },
      },
      async ({ documentId, name, fromRevisionId }) => {
        await guard.doc(documentId, 'editor');
        return this.json(await this.documents.createBranch(documentId, { name, fromRevisionId }));
      },
    );

    server.registerTool(
      'knowledge_create_revision',
      {
        description:
          'Create a new markdown revision on a branch (immutable; parented on the branch head), upload the content and finalize it for indexing. Pass baseRevisionId for optimistic concurrency: the call is rejected if the branch head has moved past it. ' +
          'Content without a frontmatter block keeps the branch head\'s frontmatter (tags, relations); include a block to replace it.',
        inputSchema: {
          documentId: z.string().uuid(),
          branch: z.string().optional(),
          baseRevisionId: z.string().uuid().optional(),
          content: z.string().min(1),
          message: z.string().optional(),
        },
      },
      async ({ documentId, branch, baseRevisionId, content, message }) => {
        await guard.doc(documentId, 'editor');
        return this.json(await this.createRevision(documentId, { branch, baseRevisionId, content, message }, principal.userId));
      },
    );

    server.registerTool(
      'knowledge_create_merge_request',
      {
        description:
          'Open a GitLab-style merge request between two branches of a document. Target defaults to the default branch.',
        inputSchema: {
          documentId: z.string().uuid(),
          sourceBranch: z.string().min(1),
          targetBranch: z.string().min(1).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
        },
      },
      async ({ documentId, sourceBranch, targetBranch, title, description }) => {
        await guard.doc(documentId, 'editor');
        return this.json(await this.mergeRequests.create(documentId, { sourceBranch, targetBranch, title, description }, principal.userId));
      },
    );

    server.registerTool(
      'knowledge_list_merge_requests',
      {
        description:
          'List merge requests across a workspace, filterable by document, status, author, or assigned reviewer. ' +
          'Cursor-paginated; mergeBaseRevisionId is null in list rows (fetch one MR for it).',
        inputSchema: {
          workspaceId: z.string().uuid(),
          documentId: z.string().uuid().optional(),
          status: z.enum(['open', 'merged', 'closed']).optional(),
          authorId: z.string().uuid().optional(),
          reviewerId: z.string().uuid().optional(),
          search: z.string().optional().describe('Case-insensitive title substring match'),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      async (query) => {
        await guard.ws(query.workspaceId, 'viewer');
        return this.json(await this.mergeRequests.listWorkspace(query, await guard.scope(query.workspaceId)));
      },
    );

    server.registerTool(
      'knowledge_get_merge_request',
      {
        description:
          'Get one merge request (heads, merge base, approvals, reviewers, draft flag). ' +
          'Set includeDiff for the merge-base text+structural diff, semantic for the graph-projection diff too.',
        inputSchema: {
          mergeRequestId: z.string().uuid(),
          includeDiff: z.boolean().optional(),
          semantic: z.boolean().optional(),
        },
      },
      async ({ mergeRequestId, includeDiff, semantic }) => {
        await guard.mr(mergeRequestId, 'viewer');
        return this.json(
            includeDiff
              ? await this.mergeRequests.diff(mergeRequestId, { semantic })
              : await this.mergeRequests.get(mergeRequestId),
          );
      },
    );

    server.registerTool(
      'knowledge_approve_merge_request',
      {
        description:
          'Approve an open merge request as the connected user. Counts toward the MR_REQUIRED_APPROVALS merge gate ' +
          'unless that user also authored it (self-approvals never count). Only approve when the user asks you to.',
        inputSchema: { mergeRequestId: z.string().uuid() },
      },
      async ({ mergeRequestId }) => {
        await guard.mr(mergeRequestId, 'editor');
        return this.json(await this.mergeRequests.approve(mergeRequestId, principal.userId));
      },
    );

    server.registerTool(
      'knowledge_close_merge_request',
      {
        description: 'Close an open merge request without merging (reopenable via the REST API).',
        inputSchema: { mergeRequestId: z.string().uuid() },
      },
      async ({ mergeRequestId }) => {
        await guard.mr(mergeRequestId, 'editor');
        return this.json(await this.mergeRequests.close(mergeRequestId, principal.userId));
      },
    );

    server.registerTool(
      'knowledge_comment_merge_request',
      {
        description:
          'Comment on an open merge request: replies into the given thread, or starts a new (unanchored) ' +
          'discussion thread when threadId is omitted.',
        inputSchema: {
          mergeRequestId: z.string().uuid(),
          body: z.string().min(1),
          threadId: z.string().uuid().optional(),
        },
      },
      async ({ mergeRequestId, body, threadId }) => {
        await guard.mr(mergeRequestId, 'editor');
        return this.json(
            threadId
              ? await this.mergeRequestThreads.reply(mergeRequestId, threadId, body, principal.userId)
              : await this.mergeRequestThreads.createThread(mergeRequestId, { body }, principal.userId),
          );
      },
    );

    server.registerTool(
      'knowledge_merge_revision',
      {
        description:
          'Merge an open merge request ("merge-commit" creates a two-parent DAG node, "squash" a single-parent one). ' +
          'Fails with a comparison link when the target branch diverged — rebase the source branch first. ' +
          'Gated: draft MRs and MRs below MR_REQUIRED_APPROVALS non-author approvals are rejected with 409 details.',
        inputSchema: {
          mergeRequestId: z.string().uuid(),
          strategy: z.enum(['merge-commit', 'squash']).optional(),
        },
      },
      async ({ mergeRequestId, strategy }) => {
        await guard.mr(mergeRequestId, 'editor');
        return this.json(await this.mergeRequests.merge(mergeRequestId, strategy ?? 'merge-commit', principal));
      },
    );

    server.registerTool(
      'knowledge_query_graph',
      {
        description:
          'TRUSTED-OPERATOR ONLY (plan.md §9): read-only SQL over the graph store. Single SELECT statement, ' +
          'row-limited, workspace predicate enforced server-side; every call is written to the audit log.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          query: z.string().min(1).describe('A single read-only SELECT (ArcadeDB SQL)'),
          limit: z.number().int().min(1).max(1000).optional(),
        },
      },
      async ({ workspaceId, query, limit }) => {
        await guard.ws(workspaceId, 'admin', true);
        const started = Date.now();
        const base = {
          workspaceId,
          actor: principal.mode === 'dev' ? 'mcp-operator' : principal.userId,
          action: 'graph.query',
          // Past every page restriction, as the REST twin records (#76).
          params: { query, limit: limit ?? 200, aclBypass: true },
        };
        try {
          const { rows, truncated } = await this.graph.operatorQuery(workspaceId, query, limit ?? 200);
          await this.audit.record({ ...base, rowCount: rows.length, durationMs: Date.now() - started, ok: true });
          return this.json({ rows, rowCount: rows.length, truncated });
        } catch (e) {
          await this.audit.record({
            ...base,
            durationMs: Date.now() - started,
            ok: false,
            error: (e as Error).message,
          });
          throw e;
        }
      },
    );

    server.registerTool(
      'knowledge_get_historical_context',
      {
        description:
          'What the knowledge base stated about an entity at a given revision (plan.md §11 historical queries): ' +
          'the fact snapshot at that point in the revision DAG, plus the entity\u2019s current neighborhood for contrast.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          entityId: z.string().min(1).describe('Entity key, e.g. "service:identity"'),
          atRevisionId: z.string().uuid(),
        },
      },
      async ({ workspaceId, entityId, atRevisionId }) => {
        await guard.ws(workspaceId, 'viewer');
        const revision = await this.prisma.documentRevision.findUnique({
          where: { id: atRevisionId },
          include: { document: true },
        });
        if (!revision || revision.document.workspaceId !== workspaceId) {
          throw new Error(`Revision ${atRevisionId} not found in workspace ${workspaceId}`);
        }
        await guard.doc(revision.documentId, 'viewer');
        const at = await this.history.factsAt(revision.documentId, atRevisionId);
        const currentNeighborhood = await this.entities
          .neighbors(await guard.scope(workspaceId), entityId, 1)
          .catch(() => null);
        return this.json({
          entityId,
          atRevisionId,
          document: { documentId: revision.documentId, title: revision.document.title },
          factsAboutEntity: at.facts.filter((f) => f.targetKey === entityId),
          allFactsAtRevision: at.facts,
          effectiveRevisionId: at.effectiveRevisionId,
          currentNeighborhood,
        });
      },
    );

    server.registerTool(
      'knowledge_ingest',
      {
        description:
          'Force reindex of a document\u2019s branch-head revisions (or every branch head in the workspace).',
        inputSchema: {
          workspaceId: z.string().uuid(),
          documentId: z.string().uuid().optional(),
        },
      },
      async ({ workspaceId, documentId }) => {
        await guard.ws(workspaceId, 'admin');
        return this.json(await this.ingestionAdmin.reindex(workspaceId, documentId));
      },
    );

    // ------------------------------------------------------------ orientation
    // The three tools an agent needs before any other: who am I, where can I
    // look, and how do I add a page. Without whoami a remote client has no way
    // to learn a workspaceId except by being told one.
    server.registerTool(
      'knowledge_whoami',
      {
        description:
          'Start here. Who this connection acts as, what its API key is limited to, and every workspace it can reach with your role in it and its projects (ids included). Every other tool takes one of these workspaceIds.',
        inputSchema: {},
      },
      async () => this.json(await this.whoami(principal)),
    );

    server.registerTool(
      'knowledge_list_documents',
      {
        description:
          'The page tree of a workspace, optionally one project: titles, ids, categories, nesting and each page\'s ' +
          'verification state. Archived pages are absent unless includeArchived is true. Use it to browse; use ' +
          'knowledge_search to find.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          projectId: z.string().uuid().optional().describe('Restrict to one project'),
          parentId: z.string().uuid().optional().describe('Children of this page; omit for the top level'),
          depth: z.number().int().min(1).max(10).optional().describe('Levels to load; omit for the whole tree'),
          includeArchived: z.boolean().optional().describe('Also list archived pages (default false)'),
        },
      },
      async ({ workspaceId, projectId, parentId, depth, includeArchived }) => {
        return this.json(
          await this.documents.getTree(await guard.pages(workspaceId), projectId, {
            parentId: parentId ?? null,
            ...(depth ? { depth } : {}),
            ...(includeArchived ? { includeArchived: true } : {}),
          }),
        );
      },
    );

    server.registerTool(
      'knowledge_create_document',
      {
        description:
          'Create a new page from markdown in a project, optionally nested under another page. It is indexed in the background (poll knowledge_get_document for status "indexed"). To change an existing page, branch and open a merge request instead. ' +
          'To start from a template (an ADR, RFC, runbook…), pass templateRef and the placeholder values knowledge_get_template lists — with no content the server fills the template in; with content, yours wins and the template is recorded as where the page came from.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          projectId: z.string().uuid().describe('From knowledge_whoami or knowledge_list_projects'),
          title: z.string().min(1).max(300),
          content: z
            .string()
            .min(1)
            .optional()
            .describe('Markdown body; YAML frontmatter is allowed and indexed. Required unless templateRef is given'),
          parentId: z.string().uuid().optional().describe('Nest under this page'),
          category: z.enum(DOCUMENT_CATEGORIES).optional().describe('Defaults to the template’s category'),
          templateRef: z
            .string()
            .optional()
            .describe('A template id or builtin:<key> from knowledge_list_templates'),
          templateVersion: z.number().int().positive().optional().describe('Pin a version; the current one when omitted'),
          values: z
            .record(z.string(), z.string())
            .optional()
            .describe('Placeholder values by name: text, an ISO date, or a user/page id, as knowledge_get_template declares'),
        },
      },
      async ({ workspaceId, projectId, title, content, parentId, category, templateRef, templateVersion, values }) => {
        await guard.ws(workspaceId, 'editor');
        if (!content && !templateRef) throw new Error('Pass content, or a templateRef to start from.');
        await this.permissions.requireCreateUnder(await guard.scope(workspaceId), {
          projectId,
          ...(parentId ? { parentId } : {}),
        });
        return this.json(
          await this.documents.createDocument(
            {
              workspaceId,
              projectId,
              title,
              ...(content ? { content: { mode: 'inline', format: 'markdown', text: content } } : {}),
              ...(parentId ? { parentId } : {}),
              ...(category ? { category } : {}),
              ...(templateRef ? { template: { ref: templateRef, version: templateVersion, values } } : {}),
            },
            principal.userId,
          ),
        );
      },
    );

    // ------------------------------------------------------------ templates
    // Read-only (issue #69): an agent picks a shape here and writes through
    // knowledge_create_document, so WRITE_TOOLS does not grow.
    server.registerTool(
      'knowledge_list_templates',
      {
        description:
          'List the page templates offered in a workspace (built-ins such as builtin:adr, builtin:runbook, builtin:postmortem, plus the workspace\'s own). Pass projectId to include that project\'s templates.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          projectId: z.string().uuid().optional(),
        },
      },
      async ({ workspaceId, projectId }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(await this.templates.list({ workspaceId, ...(projectId ? { projectId } : {}) }));
      },
    );

    server.registerTool(
      'knowledge_get_template',
      {
        description:
          'One template: its markdown source, category, default tags and relations, and the placeholders (name, kind, required) to pass as values to knowledge_create_document.',
        inputSchema: {
          workspaceId: z.string().uuid(),
          templateRef: z.string().describe('A template id or builtin:<key>'),
          version: z.number().int().positive().optional(),
        },
      },
      async ({ workspaceId, templateRef, version }) => {
        await guard.ws(workspaceId, 'viewer');
        return this.json(await this.templates.getByRef(workspaceId, templateRef, version));
      },
    );

    // ------------------------------------------------------------ the skill
    // The same SKILL.md the connection page hands out, served where a client
    // that has no skills directory can still reach it: as a resource to read,
    // and as a prompt to invoke (`/mcp__knowledge__guide` in Claude Code).
    server.registerResource(
      'skill',
      'knowledge://skill',
      {
        title: 'Knowledge platform skill',
        description: 'How to use this knowledge base well: the workspaces you can reach, the tools, and the flows.',
        mimeType: 'text/markdown',
      },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await this.skillFor(principal) }] }),
    );
    server.registerPrompt(
      'guide',
      {
        title: 'Knowledge platform guide',
        description: 'Load the knowledge-platform skill into the conversation before working with this knowledge base.',
      },
      async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: await this.skillFor(principal) } }],
      }),
    );

    // ------------------------------------------------- AI-readable (#68)
    // The /markdown and llms.txt representations as resource templates. Reads,
    // not tools, so WRITE_TOOLS is untouched. Each read goes through
    // AiReadableService — the REST code path — so the text is byte-identical,
    // and each starts with the same guard as the REST route's @Access.
    // AI_READABLE_ENABLED=false: the templates are simply not offered.
    // No llms-full resource: too large for one read; use search + page reads.
    if (this.aiReadable.enabled()) {
      server.registerResource(
        'document-markdown',
        new ResourceTemplate('knowledge://documents/{documentId}.md', { list: undefined }),
        {
          title: 'Page as markdown',
          description: 'One page (default-branch head) as plain markdown — the same text as GET /v1/documents/:id/markdown.',
          mimeType: 'text/markdown',
        },
        async (uri, { documentId }) => {
          const id = String(documentId);
          await guard.doc(id, 'viewer');
          const result = await this.aiReadable.pageMarkdown(id, { frontmatter: false });
          return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: result.status === 200 ? result.body : '' }] };
        },
      );
      server.registerResource(
        'workspace-llms-txt',
        new ResourceTemplate('knowledge://workspaces/{workspaceId}/llms.txt', { list: undefined }),
        {
          title: 'Workspace llms.txt',
          description: 'llms.txt index of a workspace: a section per project, pages in tree order.',
          mimeType: 'text/plain',
        },
        async (uri, { workspaceId }) => {
          const id = String(workspaceId);
          await guard.ws(id, 'viewer');
          const result = await this.aiReadable.workspaceIndex(id);
          return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: result.status === 200 ? result.body : '' }] };
        },
      );
      server.registerResource(
        'project-llms-txt',
        new ResourceTemplate('knowledge://projects/{projectId}/llms.txt', { list: undefined }),
        {
          title: 'Project llms.txt',
          description: 'llms.txt index of one project, pages in tree order.',
          mimeType: 'text/plain',
        },
        async (uri, { projectId }) => {
          const id = String(projectId);
          await guard.project(id, 'viewer');
          const result = await this.aiReadable.projectIndex(id);
          return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: result.status === 200 ? result.body : '' }] };
        },
      );
    }

    registerCaptureTools(server, {
      captures: this.captures,
      principal,
      guard,
      workspaceOfDocument: (id) => this.access.workspaceOfDocument(id),
      json: (value) => this.json(value),
    });

    return { server, tools: settleTools(handles, principal) };
  }

  /** The SKILL.md for `principal` — see skill.ts. `url` overrides the endpoint it names. */
  async skillFor(principal: Principal, url?: string): Promise<string> {
    return renderSkill({
      url: url ?? this.publicUrl(),
      serverName: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      authMode: this.config.get('AUTH_MODE') === 'api-key' ? 'api-key' : 'none',
      webUrl: String(this.config.get('WEB_BASE_URL') ?? 'http://localhost:5173').replace(/\/+$/, ''),
      whoami: await this.whoami(principal),
      tools: this.toolsFor(principal),
    });
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
        ? { scope: principal.apiKey.scope, workspaceId: principal.apiKey.workspaceId }
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
  private guardFor(principal: Principal) {
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
      doc: async (id: string, role: WorkspaceRole) =>
        this.permissions.requireResource(principal, await this.access.workspaceOfDocument(id), { type: 'document', id }, role, false),
      /** `doc` at editor for a CAPTURE_TOOLS handler, the page twin of `captureWs`. */
      captureDoc: async (id: string) =>
        this.permissions.requireResource(principal, await this.access.workspaceOfDocument(id), { type: 'document', id }, 'editor', false, {
          capture: true,
        }),
      project: async (id: string, role: WorkspaceRole) =>
        this.permissions.requireResource(principal, await this.access.workspaceOfProject(id), { type: 'project', id }, role, false),
      mr: async (id: string, role: WorkspaceRole) => {
        const { workspaceId, documentId } = await this.access.documentOfMergeRequest(id);
        await this.permissions.requireResource(principal, workspaceId, { type: 'document', id: documentId }, role, false);
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
      connector: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOfConnector(id), role),
      connectorRun: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOfConnectorRun(id), role),
      workflowRun: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOfWorkflowRun(id), role),
      exportJob: (id: string, role: WorkspaceRole) => check(() => this.access.workspaceOfExport(id), role),
    };
  }

  /** Inline-content revision flow: draft on branch head → put bytes → finalize. */
  private async createRevision(
    documentId: string,
    opts: { branch?: string; baseRevisionId?: string; content: string; message?: string },
    authorId: string,
  ) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    const branchName = opts.branch ?? document.defaultBranch;
    const branchRow = await this.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId, name: branchName } },
    });
    if (opts.baseRevisionId) {
      if (!branchRow) throw new Error(`Branch ${branchName} not found on document ${documentId}`);
      if (branchRow.headRevisionId !== opts.baseRevisionId) {
        // plan.md §7 optimistic concurrency: equivalent of HTTP 409 + comparison link.
        throw new Error(
          `Conflict: branch ${branchName} head is ${branchRow.headRevisionId}, not ${opts.baseRevisionId}. ` +
            `Compare with knowledge_compare_revisions before retrying.`,
        );
      }
    }

    // The new revision parents on the branch head, so that is whose frontmatter
    // a bare body keeps. A head with no readable content has none to keep.
    const base = branchRow?.headRevisionId
      ? await this.documents.getContent(documentId, branchRow.headRevisionId).catch(() => null)
      : null;
    const content = keepFrontmatter(opts.content, base?.frontmatter);

    const draft = await this.documents.createRevision(
      documentId,
      { branch: branchName, message: opts.message, contentType: 'text/markdown' },
      undefined,
      authorId,
    );
    const row = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
    await this.storage.putObjectText(row.s3Key, content, 'text/markdown');
    return this.documents.finalizeRevision(documentId, draft.revisionId);
  }

  private json(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
  }
}
