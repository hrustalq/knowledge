import { z } from 'zod';
import { MAX_INLINE_TEXT_CHARS } from '../../documents/dto/documents.dto.js';
import { json, type McpToolContext } from './context.js';

/** Merge requests: open, list, review, merge (plan.md §7). */
export function registerMergeRequestsTools(ctx: McpToolContext): void {
  const { server, principal, guard, svc } = ctx;
  server.registerTool(
    'knowledge_create_merge_request',
    {
      description:
        'Open a GitLab-style merge request from a branch. A branch is its project\'s, so the merge request carries every page ' +
        'the branch changed. Name the branch by projectId (see knowledge_list_branches) or by one documentId it changed. ' +
        'Target defaults to the default branch.',
      inputSchema: {
        documentId: z.string().uuid().optional().describe('A page the branch changed; or pass projectId'),
        projectId: z.string().uuid().optional().describe('The project whose branch sourceBranch is; or pass documentId'),
        sourceBranch: z.string().min(1),
        targetBranch: z.string().min(1).optional(),
        title: z.string().min(1),
        description: z.string().optional(),
      },
    },
    async ({ documentId: pageId, projectId, sourceBranch, targetBranch, title, description }) => {
      // By project: opened from the first page, by title, the branch wrote that the caller may open.
      const anchorOf = async (id: string) => {
        const { branches } = await svc.mergeRequests.projectBranches(id, await guard.scope(await guard.project(id, 'editor')));
        const page = branches.find((b) => b.name === sourceBranch)?.pages[0]?.documentId;
        if (!page) throw new Error(`Branch "${sourceBranch}" has changed no page you can open in this project.`);
        return page;
      };
      if (!pageId && !projectId) throw new Error('Pass documentId or projectId.');
      const documentId = pageId ?? (await anchorOf(projectId!));
      await guard.doc(documentId, 'editor');
      await guard.branches(documentId, { branchNames: [sourceBranch, ...(targetBranch ? [targetBranch] : [])] }, 'editor');
      return json(await svc.mergeRequests.create(documentId, { sourceBranch, targetBranch, title, description }, principal.userId));
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
        documentId: z.string().uuid().optional().describe('Merge requests whose branch changed this page'),
        projectId: z.string().uuid().optional(),
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
      return json(await svc.mergeRequests.listWorkspace(query, await guard.scope(query.workspaceId)));
    },
  );

  server.registerTool(
    'knowledge_get_merge_request',
    {
      description:
        'Get one merge request (heads, merge base, approvals, reviewers, draft flag). ' +
        'Set includeDiff for the merge-base text+structural diff of every page it changes (`pages`), semantic for the graph-projection diff too. ' +
        'Set includeConflicts for its 3-way state instead: how many pages are behind the target, and each conflicting page with its ' +
        'hunks and the merge with git conflict markers (`text`) — resolve those and pass them to knowledge_update_merge_request_branch.',
      inputSchema: {
        mergeRequestId: z.string().uuid(),
        includeDiff: z.boolean().optional(),
        semantic: z.boolean().optional(),
        includeConflicts: z.boolean().optional(),
      },
    },
    async ({ mergeRequestId, includeDiff, semantic, includeConflicts }) => {
      const workspaceId = await guard.mr(mergeRequestId, 'viewer');
      if (includeConflicts) return json(await svc.mergeRequests.mergeConflicts(mergeRequestId, await guard.scope(workspaceId)));
      return json(
          includeDiff
            ? await svc.mergeRequests.diff(mergeRequestId, await guard.scope(workspaceId), { semantic })
            : await svc.mergeRequests.get(mergeRequestId),
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
      return json(await svc.mergeRequests.approve(mergeRequestId, principal.userId));
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
      return json(await svc.mergeRequests.close(mergeRequestId, principal.userId));
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
      return json(
          threadId
            ? await svc.mergeRequestThreads.reply(mergeRequestId, threadId, body, principal.userId)
            : await svc.mergeRequestThreads.createThread(mergeRequestId, { body }, principal.userId),
        );
    },
  );

  server.registerTool(
    'knowledge_merge_revision',
    {
      description:
        'Merge an open merge request ("merge-commit" creates a two-parent DAG node, "squash" a single-parent one). ' +
        'A page whose target moved is merged 3-way; overlapping edits fail with 409 `conflict` naming the pages and hunks — ' +
        'resolve them with knowledge_update_merge_request_branch. ' +
        'Gated: draft MRs and MRs below MR_REQUIRED_APPROVALS non-author approvals are rejected with 409 details.',
      inputSchema: {
        mergeRequestId: z.string().uuid(),
        strategy: z.enum(['merge-commit', 'squash']).optional(),
      },
    },
    async ({ mergeRequestId, strategy }) => {
      await guard.mr(mergeRequestId, 'editor');
      return json(await svc.mergeRequests.merge(mergeRequestId, strategy ?? 'merge-commit', principal));
    },
  );

  server.registerTool(
    'knowledge_update_merge_request_branch',
    {
      description:
        "Update a merge request's source branch from its target (GitLab's \"Update branch\"): merges the target into the " +
        'source on every page behind it, as two-parent revisions — never a rebase. A conflicting page needs a resolution: ' +
        'read it with knowledge_get_merge_request includeConflicts, replace each conflict-marker block with the resolved text, ' +
        'and pass the whole body with the targetHeadRevisionId it showed. 409 `conflict` while one is missing.',
      inputSchema: {
        mergeRequestId: z.string().uuid(),
        resolutions: z
          .array(z.object({ documentId: z.string().uuid(), targetHeadRevisionId: z.string().uuid(), content: z.string().max(MAX_INLINE_TEXT_CHARS) }))
          .max(1000)
          .optional(),
      },
    },
    async ({ mergeRequestId, resolutions }) => {
      await guard.mr(mergeRequestId, 'editor');
      return json(await svc.mergeRequests.updateBranch(mergeRequestId, { resolutions }, principal));
    },
  );
}
