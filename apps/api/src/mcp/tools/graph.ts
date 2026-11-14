import { z } from 'zod';
import { RELATION_EDGE_TYPES, CONFLICT_STATUSES, RELEASE_TAG_NAME_PATTERN } from '@knowledge/contracts';
import { MCP_AS_OF, MCP_KNOWN_AT } from '../mcp-tools.js';
import { withAsOf } from '../../graph/temporal.js';
import { MAX_COMMUNITY_LEVELS } from '../../agents/communities.js';
import { json, type McpToolContext } from './context.js';

/** The relation graph, its history, release tags, conflicts and communities (Phase 4–5, #81). */
export function registerGraphTools(ctx: McpToolContext): void {
  const { server, principal, guard, svc } = ctx;
  server.registerTool(
    'knowledge_get_workspace_graph',
    {
      description:
        'The whole workspace (or one project) as a single relation graph: every document as a node, every entity it references, and the typed edges between them with provenance. Use this for an overview of how a knowledge base hangs together — or to find orphan pages, which appear with degree 0. For one page\'s neighbourhood use knowledge_find_relations instead.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid().optional().describe('Restrict the graph to one project'),
        asOf: z.string().optional().describe(MCP_AS_OF),
        knownAt: z.string().optional().describe(MCP_KNOWN_AT),
      },
    },
    async ({ workspaceId, projectId, asOf, knownAt }) => {
      await guard.ws(workspaceId, 'viewer');
      if (asOf || knownAt) await guard.history(workspaceId);
      const at = await svc.temporal.resolve(workspaceId, asOf, knownAt);
      return json(withAsOf(await svc.documents.getWorkspaceGraph(await guard.scope(workspaceId), projectId, at), at));
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
        asOf: z.string().optional().describe(MCP_AS_OF),
        knownAt: z.string().optional().describe(MCP_KNOWN_AT),
      },
    },
    async ({ workspaceId, entity, relationship, depth, asOf, knownAt }) => {
      await guard.ws(workspaceId, 'viewer');
      if (asOf || knownAt) await guard.history(workspaceId);
      const at = await svc.temporal.resolve(workspaceId, asOf, knownAt);
      const scope = await guard.scope(workspaceId);
      return json(withAsOf(await svc.entities.neighbors(scope, entity, depth ?? 1, relationship ? [relationship] : undefined, at), at));
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
        asOf: z.string().optional().describe(MCP_AS_OF),
        knownAt: z.string().optional().describe(MCP_KNOWN_AT),
      },
    },
    async ({ workspaceId, entityId, direction, maxDepth, asOf, knownAt }) => {
      await guard.ws(workspaceId, 'viewer');
      if (asOf || knownAt) await guard.history(workspaceId);
      const at = await svc.temporal.resolve(workspaceId, asOf, knownAt);
      const scope = await guard.scope(workspaceId);
      return json(withAsOf(await svc.entities.impactAnalysis(scope, entityId, direction ?? 'dependents', maxDepth ?? 3, at), at));
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
        asOf: z.string().optional().describe(MCP_AS_OF),
        knownAt: z.string().optional().describe(MCP_KNOWN_AT),
      },
    },
    async ({ workspaceId, fromEntityId, toEntityId, maxDepth, asOf, knownAt }) => {
      await guard.ws(workspaceId, 'viewer');
      if (asOf || knownAt) await guard.history(workspaceId);
      const at = await svc.temporal.resolve(workspaceId, asOf, knownAt);
      return json(withAsOf(await svc.entities.trace(await guard.scope(workspaceId), fromEntityId, toEntityId, maxDepth ?? 4, at), at));
    },
  );

  server.registerTool(
    'knowledge_query_graph',
    {
      description:
        'TRUSTED-OPERATOR ONLY (plan.md §9): read-only SQL over the graph store. Single SELECT statement, ' +
        'row-limited; every call is written to the audit log. Each FROM <Type> is narrowed to the workspace ' +
        'before the query reads it, so count(*), GROUP BY, LIMIT and subqueries work as written. ' +
        'FROM may name a subquery or one of these types (key fields in brackets): ' +
        'Document [documentId, title], DocumentRevision [revisionId, documentId], ' +
        'Chunk [chunkId, documentId, revisionId, idx, text, headingPath, live], ' +
        'Entity [entityKey e.g. op:* / component:* / service:*, entityType, name], ' +
        'Community [communityId, level, parentId, title, summary, members], ChatChunk [chunkId, bindingId], ' +
        `and the relation edges ${RELATION_EDGE_TYPES.join(', ')} ` +
        '[documentId, revisionId, targetKey, live, extractor, confidence, snippet; out = Document, in = Entity]. ' +
        'Use @type (not @class) for the type name. Refused: other targets (V, schema:*, record ids), comments, MATCH, ' +
        'and any function or method off the allowlist (the error lists it).',
      inputSchema: {
        workspaceId: z.string().uuid(),
        query: z
          .string()
          .min(1)
          .describe('A single read-only SELECT (ArcadeDB SQL), e.g. SELECT entityKey FROM Entity WHERE entityKey LIKE \'op:%\''),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ workspaceId, query, limit }) => {
      await guard.ws(workspaceId, 'admin', true);
      return json(await svc.graphQuery.run(workspaceId, query, limit, principal.mode === 'dev' ? 'mcp-operator' : principal.userId));
    },
  );

  // Release tags (#81): the twins of GET / POST /v1/release-tags.
  server.registerTool(
    'knowledge_list_release_tags',
    {
      description:
        'Release tags of a workspace: named instants ("v2.3", "Q3 audit") that asOf=tag:<name> reads the graph as of. Oldest first.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid().optional().describe('Workspace-wide tags plus this project\u2019s'),
      },
    },
    async ({ workspaceId, projectId }) => {
      await guard.ws(workspaceId, 'viewer');
      return json({ tags: await svc.releaseTags.list(await guard.scope(workspaceId), projectId) });
    },
  );

  server.registerTool(
    'knowledge_create_release_tag',
    {
      description:
        'Name an instant (now, or `at`) so the graph can later be read as of it with asOf=tag:<name>. Names are unique per workspace.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        name: z.string().regex(new RegExp(RELEASE_TAG_NAME_PATTERN)).describe('Letters, digits and . _ - /, at most 64'),
        projectId: z.string().uuid().optional().describe('Only this project\u2019s views; the whole workspace when absent'),
        at: z.string().datetime({ offset: true }).optional().describe('ISO instant; now when absent'),
        note: z.string().max(500).optional(),
      },
    },
    async ({ workspaceId, name, projectId, at, note }) => {
      await guard.ws(workspaceId, 'editor');
      return json(await svc.releaseTags.create({ workspaceId, name, projectId, at, note }, principal.userId));
    },
  );

  // Contradictions between pages (#81): the twins of GET /v1/conflicts and
  // POST /v1/conflicts/:id/resolve|dismiss. Both under the caller's scope.
  server.registerTool(
    'knowledge_list_conflicts',
    {
      description:
        'Contradictions the arbiter found between pages: both pages, the passage each one says, and why they ' +
        'disagree. Only conflicts whose pages you may open. Newest first.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        status: z.enum(CONFLICT_STATUSES).optional().describe('Only this status; every status when omitted'),
        documentId: z.string().uuid().optional().describe('Only conflicts with this page on either side'),
      },
    },
    async ({ workspaceId, status, documentId }) => {
      await guard.ws(workspaceId, 'viewer');
      return json({ conflicts: await svc.conflicts.list(await guard.scope(workspaceId), { status, documentId }) });
    },
  );

  // Broad questions (#81, phase 7): the twin of GET /v1/graph/communities.
  server.registerTool(
    'knowledge_global_overview',
    {
      description:
        'For a broad question across the whole knowledge base ("what are our main risks?"): the communities of ' +
        'related pages closest to it, each with an agent-written summary and its pages. Read the pages before ' +
        'relying on a detail; cite pages, not summaries. Empty until the atlas agent has built communities. ' +
        'Communities form a tree (#475): level 0, the default, is the finest; level 1 and 2 are broader areas.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        question: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(20).optional(),
        level: z
          .number()
          .int()
          .min(0)
          .max(MAX_COMMUNITY_LEVELS - 1)
          .optional()
          .describe('Level of the community tree, 0 = finest (default 0)'),
      },
    },
    async ({ workspaceId, question, limit, level }) => {
      await guard.ws(workspaceId, 'viewer');
      return json({ communities: await svc.communities.overview(await guard.scope(workspaceId), question, limit ?? 5, level ?? 0) });
    },
  );

  server.registerTool(
    'knowledge_resolve_conflict',
    {
      description:
        'Close an open contradiction: "resolve" when it is fixed or explained (say how in note), "dismiss" when ' +
        'it is not a contradiction — a dismissed one stays dismissed when found again.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        conflictId: z.string().uuid(),
        action: z.enum(['resolve', 'dismiss']),
        note: z.string().max(1000).optional(),
      },
    },
    async ({ workspaceId, conflictId, action, note }) => {
      await guard.ws(workspaceId, 'editor');
      if ((await svc.conflicts.workspaceOf(conflictId)) !== workspaceId) {
        throw new Error(`Conflict ${conflictId} not found in workspace ${workspaceId}`);
      }
      const status = action === 'resolve' ? 'resolved' : 'dismissed';
      return json(await svc.conflicts.close(await guard.scope(workspaceId), conflictId, status, principal.userId, note));
    },
  );

  server.registerTool(
    'knowledge_get_historical_context',
    {
      description:
        'What the knowledge base stated about an entity at a given revision (plan.md §11 historical queries): ' +
        'the fact snapshot at that point in the revision DAG, plus the entity\u2019s current neighborhood for contrast. ' +
        'Give asOf instead of atRevisionId for the whole workspace\u2019s view of the entity at a date or release tag.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        entityId: z.string().min(1).describe('Entity key, e.g. "service:identity"'),
        atRevisionId: z.string().uuid().optional().describe('One page revision; give this or asOf'),
        asOf: z.string().optional().describe(MCP_AS_OF),
        knownAt: z.string().optional().describe(MCP_KNOWN_AT),
      },
    },
    async ({ workspaceId, entityId, atRevisionId, asOf, knownAt }) => {
      await guard.ws(workspaceId, 'viewer');
      if (!atRevisionId) {
        // #81: the entity's neighbourhood across every page, as of a point.
        await guard.history(workspaceId);
        const at = await svc.temporal.resolve(workspaceId, asOf, knownAt);
        if (!at) throw new Error('Give atRevisionId or asOf');
        const scope = await guard.scope(workspaceId);
        const [then, now] = await Promise.all([
          svc.entities.neighbors(scope, entityId, 1, undefined, at).catch(() => null),
          svc.entities.neighbors(scope, entityId, 1).catch(() => null),
        ]);
        return json({ entityId, resolvedAsOf: at.resolved, neighborhoodAsOf: then, currentNeighborhood: now });
      }
      const revision = await svc.prisma.documentRevision.findUnique({
        where: { id: atRevisionId },
        include: { document: true },
      });
      if (!revision || revision.document.workspaceId !== workspaceId) {
        throw new Error(`Revision ${atRevisionId} not found in workspace ${workspaceId}`);
      }
      await guard.doc(revision.documentId, 'viewer');
      await guard.branches(revision.documentId, { revisionIds: [atRevisionId] }, 'viewer');
      await guard.history(workspaceId, revision.documentId);
      const at = await svc.history.factsAt(revision.documentId, atRevisionId);
      const currentNeighborhood = await svc.entities
        .neighbors(await guard.scope(workspaceId), entityId, 1)
        .catch(() => null);
      return json({
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
}
