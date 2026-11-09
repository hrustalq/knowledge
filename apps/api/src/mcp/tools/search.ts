import { z } from 'zod';
import { ANSWER_FEEDBACK_REASONS, ANSWER_RATINGS, KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS, KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS, KNOWLEDGE_ISSUE_EVIDENCE_MAX, KNOWLEDGE_ISSUE_KINDS, KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS, ANALYTICS_MAX_DAYS } from '@knowledge/contracts';
import { firstPerPage } from '../../search/ranking.js';
import { currentTrace, newTraceId } from '@knowledge/observability';
import { MCP_AS_OF, MCP_KNOWN_AT } from '../mcp-tools.js';
import { SEARCH_QUERY_RULE } from '../../assistant/assistant-tool-types.js';
import { wrapUntrusted } from '../../common/untrusted.js';
import { json, type McpToolContext } from './context.js';

/** Search, answer feedback, issue reports, chat search and search usage (docs/features/38, #79, #339). */
export function registerSearchTools(ctx: McpToolContext): void {
  const { server, principal, caller, guard, svc } = ctx;
  server.registerTool(
    'knowledge_search',
    {
      description:
        'Semantic search over the knowledge base. Every result carries document/revision/chunk citations plus ' +
        'provenance: revisionNumber, changedAt (freshness), authorName, verification / trust.status (verified | ' +
        'expired | edited | requested | outdated | flagged | unverified), trust.inactive, trust.ownerId and ' +
        'factClass. Ranking already favours verified pages and demotes outdated ones; still say when a page you ' +
        'relied on is outdated, expired or edited since verification. Archived pages are absent unless ' +
        'includeArchived is true. The response traceId identifies this search. With asOf, it searches the text ' +
        'each page held then, and a result whose validTo is set has since been superseded. A result may say where ' +
        'its page sits: layer (system | component | interface | code | concept, from its entity keys) and ' +
        'communityPath (the titles of its communities, broadest first; never under asOf).',
      inputSchema: {
        workspaceId: z.string().uuid(),
        query: z.string().min(1).describe(SEARCH_QUERY_RULE),
        limit: z.number().int().min(1).max(100).optional().describe('Max hits before one-per-page (default 8)'),
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
        asOf: z.string().optional().describe(MCP_AS_OF),
        knownAt: z.string().optional().describe(MCP_KNOWN_AT),
      },
    },
    async ({ workspaceId, query, limit, projectIds, tags, includeArchived, asOf, knownAt }) => {
      const scope = await guard.pages(workspaceId);
      // One merged object: separate spreads would clobber each other.
      const filters = {
        ...(projectIds?.length ? { projectIds } : {}),
        ...(tags?.length ? { tags } : {}),
        ...(includeArchived ? { includeArchived: true } : {}),
      };
      const res = await svc.search.search(
        {
          workspaceId,
          query,
          limit: limit ?? 8,
          ...(asOf ? { asOf } : {}),
          ...(knownAt ? { knownAt } : {}),
          ...(Object.keys(filters).length ? { filters } : {}),
        },
        scope,
        caller,
      );
      // One batched read for the whole hit list (docs/features/38), and the
      // trace id of this call so an agent can quote it back to
      // knowledge_feedback.
      return json({
        ...res,
        // One entry per page (#416): an agent pays for every repeated chunk.
        results: await svc.provenance.decorateResults(workspaceId, firstPerPage(res.results)),
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
      const res = await svc.feedback.voteOverMcp(
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
      return json({ feedbackId: res.feedback.id, surface: res.feedback.surface, deduplicated: res.deduplicated });
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
      // The REST twin's `@Access('viewer', 'body')`; `report` holds the page to its own check.
      await guard.ws(workspaceId, 'viewer');
      const res = await svc.issues.report(
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
      return json({
        issueId: res.issue.id,
        status: res.issue.status,
        deduplicated: res.deduplicated,
        reportCount: res.issue.reportCount,
        ...(res.suggestionIgnored ? { suggestionIgnored: true } : {}),
        ...(res.issue.mergeRequestId ? { mergeRequestId: res.issue.mergeRequestId } : {}),
        ...(res.issue.agentRunId ? { agentRunId: res.issue.agentRunId } : {}),
      });
    },
  );

  // Usage analytics (#79): the twins of GET /v1/documents/:id/insights
  // (viewer) and the gap lists of GET /v1/analytics/search (admin).
  server.registerTool(
    'knowledge_get_page_insights',
    {
      description:
        "How a page is read over the last 30 days: views split into human, assisted (the in-app assistant and " +
        'chat bots) and agent (API keys, MCP, background runs), unique readers, median read time, the last human ' +
        'view and a daily series. Counts only, never who read it. collectingSince is null before the first view.',
      inputSchema: { documentId: z.string().uuid() },
    },
    async ({ documentId }) => {
      await guard.doc(documentId, 'viewer');
      return json(await svc.analyticsQuery.pageInsights(documentId));
    },
  );

  server.registerTool(
    'knowledge_list_search_gaps',
    {
      description:
        'Coverage gaps: queries searched over the last `days` (default 30) that found nothing (zeroResult), and ' +
        'web searches that found pages nobody opened (noClick), grouped by query with counts. Admin only. The ' +
        'query text was typed by readers and comes back wrapped as untrusted data; it is null once retention ' +
        'redacted it, and queryHash still groups it. Use it to find pages worth writing.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        days: z.number().int().min(1).max(ANALYTICS_MAX_DAYS).optional(),
      },
    },
    async ({ workspaceId, days }) => {
      await guard.ws(workspaceId, 'admin');
      const gaps = await svc.analyticsQuery.searchGaps(workspaceId, days);
      return {
        content: [{ type: 'text' as const, text: wrapUntrusted(JSON.stringify(gaps, null, 2), 'knowledge_list_search_gaps', 'search') }],
      };
    },
  );

  // Searchable groups' chat (#339): the twin of POST /v1/chat/search, under
  // the same scope — a guest reaches only granted projects' chat. Output is
  // what people typed in a group, so it is wrapped untrusted.
  server.registerTool(
    'knowledge_search_chat',
    {
      description:
        'Search what people said in the team chats (Telegram, Time, Mattermost) this workspace made searchable. ' +
        'Returns windows of messages — masked, authors as author-1, author-2… — with the chat, platform and time ' +
        'span, from chats you may read only. A chat is not a page: nobody reviewed it. Prefer a page when one ' +
        'answers, and when you rely on a chat say which and when.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        query: z.string().min(1).max(500).describe(SEARCH_QUERY_RULE),
        limit: z.number().int().min(1).max(50).optional(),
        projectIds: z.array(z.string().uuid()).max(20).optional().describe('Only chats bound to these projects'),
        from: z.string().datetime().optional().describe('Only windows still going at or after this time'),
        to: z.string().datetime().optional().describe('Only windows started at or before this time'),
      },
    },
    async ({ workspaceId, query, limit, projectIds, from, to }) => {
      const res = await svc.chatSearch.search(await guard.pages(workspaceId), {
        query,
        limit: limit ?? 10,
        ...(projectIds?.length ? { projectIds } : {}),
        ...(from ? { from: new Date(from) } : {}),
        ...(to ? { to: new Date(to) } : {}),
      });
      return { content: [{ type: 'text' as const, text: wrapUntrusted(JSON.stringify(res, null, 2), 'knowledge_search_chat', 'conversation') }] };
    },
  );
}
