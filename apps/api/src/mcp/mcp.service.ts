import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AiAgentChoice } from '@knowledge/contracts';
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
import { HistoryService } from '../documents/history.service.js';
import { IngestionAdminService } from '../ingestion/ingestion-admin.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ConnectorProducer } from '../connectors/connector.producer.js';
import { ConnectorsService, toRunInfo } from '../connectors/connectors.service.js';
import { ConnectorWorkItemsService } from '../connectors/connector-work-items.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AUTHOR_ID_STUB } from '../documents/merge-requests.service.js';

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
 * Merge-request tools (create/list/get/approve/close/comment/merge) act as
 * the zeros AUTHOR_ID_STUB — stdio has no principal, so authorship/approvals
 * from MCP are attributed to the stub identity.
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
    private readonly history: HistoryService,
    private readonly ingestionAdmin: IngestionAdminService,
    private readonly workflows: WorkflowsService,
    private readonly projects: ProjectsService,
    private readonly connectors: ConnectorsService,
    private readonly workItems: ConnectorWorkItemsService,
    private readonly connectorProducer: ConnectorProducer,
    private readonly agents: AgentRegistryService,
  ) {}

  async serveStdio(): Promise<void> {
    const server = new McpServer({ name: 'knowledge', version: '0.9.0' });

    server.registerTool(
      'knowledge_search',
      {
        description:
          'Semantic search over the knowledge base. Every result carries document/revision/chunk citations.',
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
        },
      },
      async ({ workspaceId, query, limit, projectIds, tags }) => {
        // One merged object: separate spreads would clobber each other.
        const filters = {
          ...(projectIds?.length ? { projectIds } : {}),
          ...(tags?.length ? { tags } : {}),
        };
        return this.json(
          await this.search.search({
            workspaceId,
            query,
            limit: limit ?? 20,
            ...(Object.keys(filters).length ? { filters } : {}),
          }),
        );
      },
    );

    server.registerTool(
      'knowledge_list_projects',
      {
        description:
          'List the projects in a workspace. Workspace > Project > Document — every document belongs to exactly one project.',
        inputSchema: { workspaceId: z.string().uuid() },
      },
      async ({ workspaceId }) => this.json(await this.projects.list({ workspaceId })),
    );

    server.registerTool(
      'knowledge_list_connectors',
      {
        description:
          'List the external systems this workspace syncs with (Confluence, Jira, Notion, markdown/git). Each entry says which direction it moves content, how many pages it has claimed, and how its last sync went.',
        inputSchema: { workspaceId: z.string().uuid() },
      },
      async ({ workspaceId }) => this.json(await this.connectors.list(workspaceId)),
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
      async ({ runId }) => this.json(await this.connectors.getRun(runId)),
    );

    // Work items (docs/features/32). Reading only: opening an issue is an act
    // attributed to a person, and stdio has no principal — the same reason
    // workflow approval is deliberately absent from this surface.
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
      async ({ workspaceId, projectId }) =>
        this.json(await this.documents.getWorkspaceGraph(workspaceId, projectId)),
    );

    // ------------------------------------------------------------ workflows
    // Dynamic document workflows (docs/features/17). Starting a run is exposed
    // but approving one is not: approval writes pages into the knowledge base,
    // and stdio has no principal to attribute that to. An agent can kick a
    // chain off and watch it; a person still decides what gets published.
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
      async ({ workspaceId, projectId }) =>
        this.json(await this.workflows.list({ workspaceId, ...(projectId ? { projectId } : {}) })),
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
      async ({ workspaceId, definitionId, rootDocumentId, note }) =>
        this.json(
          await this.workflows.startRun(
            { workspaceId, definitionId, rootDocumentId, ...(note ? { note } : {}) },
            AUTHOR_ID_STUB,
            'mcp',
          ),
        ),
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
    // and bill as, and stdio has no principal — every other write tool here
    // settles for AUTHOR_ID_STUB, but starting unattended AI is the one place
    // where an unauthenticated transport should not be the thing that starts
    // it. Runs begin from the Agents tab or from a schedule, both of which name
    // a real user. (docs/features/20-agents-todo.md item 3.)

    server.registerTool(
      'knowledge_get_workflow_run',
      {
        description:
          'A workflow run with its frozen step graph and its node tree — every intermediate result, including drafts still awaiting review.',
        inputSchema: { runId: z.string().uuid() },
      },
      async ({ runId }) => this.json(await this.workflows.getRun(runId)),
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
      async ({ workspaceId, entity, relationship, depth }) =>
        this.json(
          await this.entities.neighbors(workspaceId, entity, depth ?? 1, relationship ? [relationship] : undefined),
        ),
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
      async ({ workspaceId, entityId, direction, maxDepth }) =>
        this.json(await this.entities.impactAnalysis(workspaceId, entityId, direction ?? 'dependents', maxDepth ?? 3)),
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
      async ({ workspaceId, fromEntityId, toEntityId, maxDepth }) =>
        this.json(await this.entities.trace(workspaceId, fromEntityId, toEntityId, maxDepth ?? 4)),
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
      async ({ documentId, revisionId }) =>
        this.json(await this.documents.getDocument(documentId, revisionId)),
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
      async ({ documentId, branch }) =>
        this.json(await this.documents.listRevisions(documentId, branch)),
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
      async ({ documentId, fromRevisionId, toRevisionId, mode, includeSemanticDiff }) =>
        this.json(
          await this.compare.compare(documentId, fromRevisionId, toRevisionId, mode ?? 'direct', {
            structural: true,
            semantic: includeSemanticDiff ?? false,
          }),
        ),
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
      async ({ documentId, name, fromRevisionId }) =>
        this.json(await this.documents.createBranch(documentId, { name, fromRevisionId })),
    );

    server.registerTool(
      'knowledge_create_revision',
      {
        description:
          'Create a new markdown revision on a branch (immutable; parented on the branch head), upload the content and finalize it for indexing. Pass baseRevisionId for optimistic concurrency: the call is rejected if the branch head has moved past it.',
        inputSchema: {
          documentId: z.string().uuid(),
          branch: z.string().optional(),
          baseRevisionId: z.string().uuid().optional(),
          content: z.string().min(1),
          message: z.string().optional(),
        },
      },
      async ({ documentId, branch, baseRevisionId, content, message }) =>
        this.json(await this.createRevision(documentId, { branch, baseRevisionId, content, message })),
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
      async ({ documentId, sourceBranch, targetBranch, title, description }) =>
        this.json(await this.mergeRequests.create(documentId, { sourceBranch, targetBranch, title, description })),
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
      async (query) => this.json(await this.mergeRequests.listWorkspace(query)),
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
      async ({ mergeRequestId, includeDiff, semantic }) =>
        this.json(
          includeDiff
            ? await this.mergeRequests.diff(mergeRequestId, { semantic })
            : await this.mergeRequests.get(mergeRequestId),
        ),
    );

    server.registerTool(
      'knowledge_approve_merge_request',
      {
        description:
          'Approve an open merge request. NOTE: approval is recorded for the MCP stub identity — it counts toward ' +
          'the MR_REQUIRED_APPROVALS merge gate unless the merge request was also authored via MCP (self-approvals never count).',
        inputSchema: { mergeRequestId: z.string().uuid() },
      },
      async ({ mergeRequestId }) => this.json(await this.mergeRequests.approve(mergeRequestId)),
    );

    server.registerTool(
      'knowledge_close_merge_request',
      {
        description: 'Close an open merge request without merging (reopenable via the REST API).',
        inputSchema: { mergeRequestId: z.string().uuid() },
      },
      async ({ mergeRequestId }) => this.json(await this.mergeRequests.close(mergeRequestId)),
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
      async ({ mergeRequestId, body, threadId }) =>
        this.json(
          threadId
            ? await this.mergeRequestThreads.reply(mergeRequestId, threadId, body)
            : await this.mergeRequestThreads.createThread(mergeRequestId, { body }),
        ),
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
      async ({ mergeRequestId, strategy }) =>
        this.json(await this.mergeRequests.merge(mergeRequestId, strategy ?? 'merge-commit')),
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
        const started = Date.now();
        const base = {
          workspaceId,
          actor: 'mcp-operator',
          action: 'graph.query',
          params: { query, limit: limit ?? 200 },
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
        const revision = await this.prisma.documentRevision.findUnique({
          where: { id: atRevisionId },
          include: { document: true },
        });
        if (!revision || revision.document.workspaceId !== workspaceId) {
          throw new Error(`Revision ${atRevisionId} not found in workspace ${workspaceId}`);
        }
        const at = await this.history.factsAt(revision.documentId, atRevisionId);
        const currentNeighborhood = await this.entities.neighbors(workspaceId, entityId, 1).catch(() => null);
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
      async ({ workspaceId, documentId }) => this.json(await this.ingestionAdmin.reindex(workspaceId, documentId)),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  /** Inline-content revision flow: draft on branch head → put bytes → finalize. */
  private async createRevision(
    documentId: string,
    opts: { branch?: string; baseRevisionId?: string; content: string; message?: string },
  ) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    const branchName = opts.branch ?? document.defaultBranch;
    if (opts.baseRevisionId) {
      const branchRow = await this.prisma.documentBranch.findUnique({
        where: { documentId_name: { documentId, name: branchName } },
      });
      if (!branchRow) throw new Error(`Branch ${branchName} not found on document ${documentId}`);
      if (branchRow.headRevisionId !== opts.baseRevisionId) {
        // plan.md §7 optimistic concurrency: equivalent of HTTP 409 + comparison link.
        throw new Error(
          `Conflict: branch ${branchName} head is ${branchRow.headRevisionId}, not ${opts.baseRevisionId}. ` +
            `Compare with knowledge_compare_revisions before retrying.`,
        );
      }
    }

    const draft = await this.documents.createRevision(documentId, {
      branch: branchName,
      message: opts.message,
      contentType: 'text/markdown',
    });
    const row = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
    await this.storage.putObjectText(row.s3Key, opts.content, 'text/markdown');
    return this.documents.finalizeRevision(documentId, draft.revisionId);
  }

  private json(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
  }
}
