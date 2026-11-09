import { z } from 'zod';
import { WIKI_SECTIONS, WORK_ITEM_SOURCE_KINDS } from '@knowledge/contracts';
import { toRunInfo } from '../../connectors/connectors.service.js';
import { json, type McpToolContext } from './context.js';

/** Connectors, the repo wiki and tracker work items (docs/features/19, 32, 46). */
export function registerConnectorsTools(ctx: McpToolContext): void {
  const { server, principal, guard, svc } = ctx;
  server.registerTool(
    'knowledge_list_connectors',
    {
      description:
        'List the external systems this workspace syncs with (Confluence, Jira, Notion, markdown/git). Each entry says which direction it moves content, how many pages it has claimed, and how its last sync went.',
      inputSchema: { workspaceId: z.string().uuid() },
    },
    async ({ workspaceId }) => {
      await guard.ws(workspaceId, 'viewer');
      return json(await svc.connectors.list(await guard.scope(workspaceId)));
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
      const row = await svc.connectors.require(connectorId);
      const run = await svc.connectors.createRun(row, direction ?? 'pull', 'manual', { externalIds, actorId: principal.userId });
      await svc.connectorProducer.enqueue(run.id);
      return json(toRunInfo(run));
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
      const run = await svc.prisma.connectorRun.findUnique({ where: { id: runId }, select: { workspaceId: true } });
      return json(await svc.connectors.getRun(runId, await guard.scope(run!.workspaceId)));
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
      return json(await svc.repoWiki.info(connectorId));
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
      const run = await svc.repoWiki.regenerate(connectorId, { sections, force, actorId: principal.userId });
      await svc.connectorProducer.enqueue(run.id);
      return json(toRunInfo(run));
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
      const row = await svc.connectors.require(connectorId);
      // A ticket on a page the caller cannot open is omitted, never refused (#424).
      const items = await svc.workItems.list(await guard.scope(row.workspaceId), row);
      const wanted = state ?? 'all';
      return json(
        items.filter((item) =>
          wanted === 'all' ? true : wanted === 'closed' ? item.state !== 'open' : item.state === 'open',
        ),
      );
    },
  );

  // #424: hand a knowledge object off to its tracker. The handoff service
  // checks edit on the object's page itself, on every call.
  server.registerTool(
    'knowledge_handoff_work_item',
    {
      description:
        'Hand a knowledge object off to the team\'s tracker (Jira, GitHub or GitLab): create a ticket for a reported ' +
        'issue, a knowledge conflict, a flagged page ("verification") or a page, or attach an existing ticket with ' +
        '`attach` (BILL-123, #45, org/repo#45 or its URL). The ticket carries a summary, a link back and a ' +
        'knowledge-ref footer, never page content; its status then syncs both ways. Without connectorId the ' +
        "object's project route decides. One ticket per object per tracker: a repeat call returns the same one.",
      inputSchema: {
        workspaceId: z.string().uuid(),
        sourceKind: z.enum(WORK_ITEM_SOURCE_KINDS),
        sourceId: z.string().uuid().describe('knowledge_issues / knowledge_conflicts id, or the page id for verification and document'),
        connectorId: z.string().uuid().optional().describe("A tracker connector; omitted = the project's route"),
        attach: z.string().min(1).max(500).optional().describe('An existing ticket to attach instead of creating one'),
      },
    },
    async ({ workspaceId, sourceKind, sourceId, connectorId, attach }) => {
      await guard.ws(workspaceId, 'editor');
      const workItem = await svc.handoffs.handoff(principal, {
        workspaceId,
        sourceKind,
        sourceId,
        ...(connectorId ? { connectorId } : {}),
        ...(attach ? { attach } : {}),
      });
      return json(workItem);
    },
  );
}
