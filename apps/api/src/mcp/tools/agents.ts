import { z } from 'zod';
import { AGENT_LEARNING_MAX_CHARS, AGENT_LEARNING_STATUSES, type AiAgentChoice } from '@knowledge/contracts';
import { json, type McpToolContext } from './context.js';

/** Agents, their learnings and document workflows (docs/features/17, 20, #70). */
export function registerAgentsTools(ctx: McpToolContext): void {
  const { server, principal, guard, svc } = ctx;
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
      return json({
        learnings: await svc.learnings.list(workspaceId, { status: status ?? 'active', ...(agentKey ? { agentKey } : {}) }),
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
        agentKey: z
          .string()
          .max(64)
          .optional()
          .describe('The agent it teaches; "mcp" teaches agents connected over MCP, like you; omit for every agent of the platform'),
        projectId: z.string().uuid().optional().describe('Applies only in this project'),
      },
    },
    async ({ workspaceId, text, agentKey, projectId }) => {
      // The REST twin is `@Access('editor', 'body')`; the proposed status is
      // fixed here, so no key — whatever its owner's role — can make one active.
      await guard.ws(workspaceId, 'editor');
      return json(
        await svc.learnings.create(
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
      return json(await svc.workflows.list({ workspaceId, ...(projectId ? { projectId } : {}) }));
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
      return json(
          await svc.workflows.startRun(
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
      const agents = await svc.agents.list(workspaceId);
      return json({
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
      return json(await svc.workflows.getRun(runId));
    },
  );
}
