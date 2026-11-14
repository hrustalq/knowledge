import type { Principal } from '../../auth/principal.js';
import { z } from 'zod';
import { DOCUMENT_CATEGORIES, DOCUMENT_VISIBILITIES, API_DOCUMENT_KINDS, API_SPEC_SYNTAXES, isStructuredKind, type ApiSpecSyntax } from '@knowledge/contracts';
import { keepFrontmatter } from '../../common/frontmatter.js';
import { applyLineEdits } from '../line-patch.js';
import { contentLines } from '../../documents/content-lines.js';
import { json, pageJson, type McpToolContext } from './context.js';
import type { McpServices } from '../mcp-services.js';

/** Pages, their revisions and branches: read, create, revise, upload and reindex. */
export function registerDocumentsTools(ctx: McpToolContext): void {
  const { server, principal, caller, guard, svc } = ctx;
  server.registerTool(
    'knowledge_get_document',
    {
      description:
        'Get a document, its head (or a given) revision and indexed chunk summaries, plus `backlinks`: the pages ' +
        'you can open whose current text links to it, with the headings they link to.',
      inputSchema: {
        documentId: z.string().uuid(),
        revisionId: z.string().uuid().optional(),
      },
    },
    async ({ documentId, revisionId }) => {
      const workspaceId = await guard.doc(documentId, 'viewer');
      if (revisionId) await guard.branches(documentId, { revisionIds: [revisionId] }, 'viewer');
      if (revisionId) await guard.history(workspaceId, documentId, [revisionId]);
      const doc = await svc.documents.getDocument(documentId, revisionId);
      void svc.analytics.view(caller, documentId, revisionId);
      const { backlinks } = await svc.documents.getBacklinks(documentId, await guard.scope(workspaceId));
      return pageJson('knowledge_get_document', { ...doc, backlinks });
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
        '`markdown` is the body without its frontmatter block; posting it back as-is keeps the frontmatter. ' +
        'Pass `lines` ({ start, end }, 1-based, inclusive, counting that `markdown`) for just those lines: the answer adds startLine, endLine, totalLines and `reference`, ' +
        'a link to exactly that passage pinned to the revision — cite a passage with it (a reader opens it highlighted, re-found on a newer head). Out of range is an error.',
      inputSchema: {
        documentId: z.string().uuid(),
        revisionId: z.string().uuid().optional(),
        lines: z.object({ start: z.number().int().min(1), end: z.number().int().min(1) }).optional(),
      },
    },
    async ({ documentId, revisionId, lines }) => {
      const workspaceId = await guard.doc(documentId, 'viewer');
      if (revisionId) await guard.branches(documentId, { revisionIds: [revisionId] }, 'viewer');
      if (revisionId) await guard.history(workspaceId, documentId, [revisionId]);
      const content = await svc.documents.getContent(documentId, revisionId);
      void svc.analytics.view(caller, documentId, content.revisionId);
      return pageJson('knowledge_get_document_content', lines ? contentLines(content, lines, svc.webUrl()) : content);
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
      const workspaceId = await guard.doc(documentId, 'viewer');
      if (branch) await guard.branches(documentId, { branchNames: [branch] }, 'viewer');
      await guard.history(workspaceId, documentId);
      return pageJson('knowledge_list_revisions', await svc.documents.listRevisions(documentId, await guard.scope(workspaceId), branch));
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
      const workspaceId = await guard.doc(documentId, 'viewer');
      await guard.branches(documentId, { revisionIds: [fromRevisionId, toRevisionId] }, 'viewer');
      await guard.history(workspaceId, documentId);
      return pageJson('knowledge_compare_revisions', 
          await svc.compare.compare(documentId, fromRevisionId, toRevisionId, mode ?? 'direct', {
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
        visibility: z
          .enum(DOCUMENT_VISIBILITIES)
          .optional()
          .describe('workspace (default): readable by everyone who can open the page; private: only you, people you share it with, and admins'),
      },
    },
    async ({ documentId, name, fromRevisionId, visibility }) => {
      await guard.doc(documentId, 'editor');
      if (fromRevisionId) await guard.branches(documentId, { revisionIds: [fromRevisionId] }, 'editor');
      return json(
        await svc.documents.createBranch(documentId, { name, fromRevisionId, ...(visibility ? { visibility } : {}) }, principal.userId),
      );
    },
  );

  server.registerTool(
    'knowledge_create_revision',
    {
      description:
        'Create a new markdown revision on a branch (immutable; parented on the branch head), upload the content and finalize it for indexing. Pass baseRevisionId for optimistic concurrency: the call is rejected if the branch head has moved past it. ' +
        'Content without a frontmatter block keeps the branch head\'s frontmatter (tags, relations); include a block to replace it. ' +
        'For an API spec document (kind openapi or asyncapi), content is the whole spec in YAML or JSON (say which with syntax); it is validated, and refused with the validator\'s messages when it does not. Its relations (what owns it: a service: or component:) go in a top-level x-knowledge-relations list shaped like frontmatter relations. ' +
        'A test fixture (kind test-fixture) is the same: its whole YAML or JSON body, checked against the specs you can open. ' +
        'With no `branch` the write goes to the default branch of the page: in a workspace whose publishMode is `review` (knowledge_whoami) that is refused with reason `review-required` for anyone but a workspace admin once the page is published — write to a branch and open a merge request.',
      inputSchema: {
        documentId: z.string().uuid(),
        branch: z.string().optional(),
        baseRevisionId: z.string().uuid().optional(),
        content: z.string().min(1),
        message: z.string().optional(),
        syntax: z.enum(API_SPEC_SYNTAXES).optional().describe('API spec and test fixture documents only: yaml (default) or json'),
      },
    },
    async ({ documentId, branch, baseRevisionId, content, message, syntax }) => {
      await guard.doc(documentId, 'editor');
      await guard.branches(
        documentId,
        { ...(branch ? { branchNames: [branch] } : {}), ...(baseRevisionId ? { revisionIds: [baseRevisionId] } : {}) },
        'editor',
      );
      return json(
        await createRevision(svc, documentId, { branch, baseRevisionId, content, message, syntax }, principal),
      );
    },
  );

  // #603: change a few lines without resending the page. The lines are the
  // base revision's, so the base must still be the branch head.
  server.registerTool(
    'knowledge_patch_document',
    {
      description:
        'Change some lines of a page instead of rewriting it: a new revision on a branch, like knowledge_create_revision. ' +
        'Line numbers are 1-based and count the `markdown` that knowledge_get_document_content returned for baseRevisionId (the body without its frontmatter, which is kept; a spec or fixture is numbered whole). ' +
        'Each edit replaces startLine..endLine (inclusive) with content; endLine = startLine - 1 inserts before startLine, startLine = line count + 1 appends, empty content deletes. ' +
        'Number every edit off that one read, not off each other; edits may not overlap. Refused when the branch head has moved past baseRevisionId: read again and renumber. ' +
        'The default branch is held to the workspace publish mode, as for knowledge_create_revision.',
      inputSchema: {
        documentId: z.string().uuid(),
        baseRevisionId: z.string().uuid().describe('The revision your line numbers come from; must be the branch head'),
        branch: z.string().optional().describe('The default branch when omitted'),
        edits: z
          .array(
            z.object({
              startLine: z.number().int().min(1),
              endLine: z.number().int().min(0),
              content: z.string(),
            }),
          )
          .min(1)
          .max(100),
        message: z.string().optional(),
      },
    },
    async ({ documentId, baseRevisionId, branch, edits, message }) => {
      await guard.doc(documentId, 'editor');
      await guard.branches(documentId, { ...(branch ? { branchNames: [branch] } : {}), revisionIds: [baseRevisionId] }, 'editor');
      const base = await svc.documents.getContent(documentId, baseRevisionId);
      const content = applyLineEdits(base.markdown, edits);
      if (content.trim() === '') throw new Error('The edits leave the page empty; archive it instead.');
      // Read only for a spec or fixture: a page's content type is markdown.
      const syntax = base.contentType.includes('json') ? 'json' : 'yaml';
      return json(await createRevision(svc, documentId, { branch, baseRevisionId, content, message, syntax }, principal));
    },
  );

  server.registerTool(
    'knowledge_list_branches',
    {
      description:
        "List a project's branches (#636): each with the pages it changed that you can open, who wrote it last and when, " +
        'and its open merge request. The default branch is left out. A branch is the project\'s: the same name on any page ' +
        'of the project is one branch, and one merge request carries all of it. Newest first and paginated, because merged ' +
        'branches stay: pass name to find one (a new page\'s id after a push), openOnly for those with an open merge request.',
      inputSchema: {
        projectId: z.string().uuid(),
        name: z.string().min(1).optional().describe('Case-insensitive branch name substring'),
        openOnly: z.boolean().optional().describe('Only branches with an open merge request'),
        cursor: z.string().regex(/^\d+$/).optional().describe('nextCursor from the previous page'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      },
    },
    async ({ projectId, name, openOnly, cursor, limit = 25 }) => {
      const scope = await guard.scope(await guard.project(projectId, 'viewer'));
      const { branches } = await svc.mergeRequests.projectBranches(projectId, scope, { name, openOnly });
      const from = Number(cursor ?? 0);
      const end = from + limit;
      return pageJson('knowledge_list_branches', { projectId, branches: branches.slice(from, end), nextCursor: end < branches.length ? String(end) : null });
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
      return json(await svc.ingestionAdmin.reindex(workspaceId, documentId));
    },
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
      return pageJson('knowledge_list_documents', 
        await svc.documents.getTree(await guard.pages(workspaceId), projectId, {
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
        'To start from a template (an ADR, RFC, runbook…), pass templateRef and the placeholder values knowledge_get_template lists — with no content the server fills the template in; with content, yours wins and the template is recorded as where the page came from. ' +
        'kind test-fixture creates a QA test fixture: content is its YAML or JSON body (fixture: 1, steps with call / manual, optional inputs and teardown; credentials only as {{secret.x}}), validated against the specs you can open; openapi / asyncapi create a spec. None of these take a template. ' +
        'To create the page from a local file instead of pasting it, pass upload: true and no content: the reply carries an upload URL, then call knowledge_finalize_upload.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid().describe('From knowledge_whoami or knowledge_list_projects'),
        title: z.string().min(1).max(300),
        content: z
          .string()
          .min(1)
          .optional()
          .describe('Markdown body; YAML frontmatter is allowed and indexed. Required unless templateRef or upload is given'),
        upload: z.boolean().optional().describe('Create the page empty and return an upload URL for its first revision (as knowledge_start_upload)'),
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
        kind: z.enum(API_DOCUMENT_KINDS).optional().describe('page (default), openapi, asyncapi or test-fixture'),
        syntax: z.enum(API_SPEC_SYNTAXES).optional().describe('Spec and test fixture documents only: yaml (default) or json'),
        visibility: z
          .enum(DOCUMENT_VISIBILITIES)
          .optional()
          .describe(
            'private (default): a draft only you can open until it is published in the app; workspace: open to everyone who can open its parent',
          ),
      },
    },
    async ({ workspaceId, projectId, title, content, upload, parentId, category, templateRef, templateVersion, values, kind, syntax, visibility }) => {
      await guard.ws(workspaceId, 'editor');
      if (upload && (content || templateRef)) throw new Error('upload replaces content and templateRef: pass one of them.');
      if (!content && !templateRef && !upload) throw new Error('Pass content, a templateRef to start from, or upload: true.');
      await svc.permissions.requireCreateUnder(await guard.scope(workspaceId), {
        projectId,
        ...(parentId ? { parentId } : {}),
      });
      const created = await svc.documents.createDocument(
        {
          workspaceId,
          projectId,
          title,
          ...(kind ? { kind } : {}),
          ...(content
            ? { content: { mode: 'inline', format: isStructuredKind(kind) ? (syntax ?? 'yaml') : 'markdown', text: content } }
            : {}),
          ...(parentId ? { parentId } : {}),
          ...(category ? { category } : {}),
          ...(templateRef ? { template: { ref: templateRef, version: templateVersion, values } } : {}),
          // An agent writing for a person starts a private draft, as the REST route does (#474).
          visibility: visibility ?? 'private',
        },
        principal.userId,
      );
      if (!upload) return json(created);
      // With no content the page is created with an empty draft revision: that is the one to upload into.
      return json({ ...created, ...(await uploadTicket(svc, created.documentId, created.revisionId)) });
    },
  );

  // #602: a page from a file on the agent's machine. MCP carries no files,
  // and the API never streams bodies — so the agent PUTs the bytes to a
  // presigned URL itself and then finalizes, the REST upload flow in two tools.
  server.registerTool(
    'knowledge_start_upload',
    {
      description:
        'Write a new revision of a page from a local file instead of pasting it: returns a presigned PUT URL (valid 15 minutes) and a curl command. ' +
        'Upload the file with it, then call knowledge_finalize_upload with the revisionId. The file is the whole page, as with knowledge_create_revision: ' +
        'a markdown file without a frontmatter block keeps the current tags and relations. Pass baseRevisionId to be refused when the branch head has moved. ' +
        'For a new page, use knowledge_create_document with upload: true. ' +
        'The default branch is held to the workspace publish mode, as for knowledge_create_revision.',
      inputSchema: {
        documentId: z.string().uuid(),
        branch: z.string().optional().describe('The default branch when omitted'),
        baseRevisionId: z.string().uuid().optional(),
        message: z.string().optional(),
        syntax: z.enum(API_SPEC_SYNTAXES).optional().describe('API spec and test fixture documents only: yaml (default) or json'),
      },
    },
    async ({ documentId, branch, baseRevisionId, message, syntax }) => {
      await guard.doc(documentId, 'editor');
      await guard.branches(
        documentId,
        { ...(branch ? { branchNames: [branch] } : {}), ...(baseRevisionId ? { revisionIds: [baseRevisionId] } : {}) },
        'editor',
      );
      return json(await startUpload(svc, documentId, { branch, baseRevisionId, message, syntax }, principal));
    },
  );

  server.registerTool(
    'knowledge_finalize_upload',
    {
      description:
        'Finish a knowledge_start_upload (or knowledge_create_document upload: true) once the file is uploaded: the revision becomes the branch head and is indexed. ' +
        'An API spec or test fixture that does not validate is refused with the validator\'s messages; upload a corrected file to the same URL and call this again.',
      inputSchema: {
        documentId: z.string().uuid(),
        revisionId: z.string().uuid(),
      },
    },
    async ({ documentId, revisionId }) => {
      await guard.doc(documentId, 'editor');
      await guard.branches(documentId, { revisionIds: [revisionId] }, 'editor');
      return json(await finalizeUpload(svc, documentId, revisionId));
    },
  );
}

/** Inline-content revision flow: draft on branch head → put bytes → finalize. */
export async function createRevision(
  svc: McpServices,
  documentId: string,
  opts: { branch?: string; baseRevisionId?: string; content: string; message?: string; syntax?: ApiSpecSyntax },
  principal: Principal,
) {
  const document = await svc.prisma.document.findUnique({ where: { id: documentId } });
  if (!document) throw new Error(`Document ${documentId} not found`);

  const branchName = opts.branch ?? document.defaultBranch;
  // A spec (#78) or fixture (#483) is its text whole: it has no frontmatter
  // to keep, and its content type comes from the kind plus the syntax named here.
  const spec = isStructuredKind(document.kind);
  // The new revision parents on the branch head, so that is whose frontmatter
  // a bare body keeps. A head with no readable content has none to keep. A
  // `baseRevisionId` that is no longer the head is writeRevision's 409.
  const headId = spec
    ? null
    : (opts.baseRevisionId ??
      (
        await svc.prisma.documentBranch.findUnique({
          where: { documentId_name: { documentId, name: branchName } },
          select: { headRevisionId: true },
        })
      )?.headRevisionId);
  const base = headId ? await svc.documents.getContent(documentId, headId).catch(() => null) : null;

  // plan.md §7 optimistic concurrency: a moved head is the REST route's 409 with its comparison link (#811).
  return svc.documents.writeRevision(
    documentId,
    {
      text: spec ? opts.content : keepFrontmatter(opts.content, base?.frontmatter),
      branch: branchName,
      message: opts.message,
      contentType: spec ? `application/${opts.syntax ?? 'yaml'}` : 'text/markdown',
      expectedHeadRevisionId: opts.baseRevisionId,
    },
    { person: principal },
    principal.userId,
  );
}

/** A draft revision plus a presigned PUT for its object (#602). */
async function startUpload(
  svc: McpServices,
  documentId: string,
  opts: { branch?: string; baseRevisionId?: string; message?: string; syntax?: ApiSpecSyntax },
  principal: Principal,
) {
  const document = await svc.prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { kind: true } });
  const draft = await svc.documents.createRevision(
    documentId,
    {
      branch: opts.branch,
      message: opts.message,
      // A page is markdown; a spec or fixture says its syntax (createRevision's own choice is yaml).
      ...(isStructuredKind(document.kind) && opts.syntax ? { contentType: `application/${opts.syntax}` } : {}),
    },
    { person: principal },
    opts.baseRevisionId,
    principal.userId,
  );
  return uploadTicket(svc, documentId, draft.revisionId);
}

/** The presigned PUT for an existing draft revision's object. */
async function uploadTicket(
  svc: McpServices,documentId: string, revisionId: string) {
  const row = await svc.prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId } });
  const url = await svc.storage.presignPut(row.s3Key, row.contentType);
  return {
    revisionId: row.id,
    upload: { method: 'PUT', url, headers: { 'Content-Type': row.contentType }, expiresInSeconds: 900 },
    curl: `curl -fsS -X PUT -H 'Content-Type: ${row.contentType}' --upload-file <path-to-file> '${url}'`,
    next: `knowledge_finalize_upload { documentId: "${documentId}", revisionId: "${row.id}" }`,
  };
}

/**
 * Finalize an uploaded draft. A markdown file without a frontmatter block
 * gets its parent's put back first, as `createRevision` does for a pasted
 * body — otherwise uploading a page's own export would drop its relations.
 */
async function finalizeUpload(
  svc: McpServices,documentId: string, revisionId: string) {
  const row = await svc.prisma.documentRevision.findFirst({
    where: { id: revisionId, documentId },
    include: { document: { select: { kind: true } }, parents: { select: { parentRevisionId: true }, orderBy: { parentOrder: 'asc' }, take: 1 } },
  });
  if (!row) throw new Error(`Revision ${revisionId} not found on document ${documentId}`);
  const parentId = row.parents[0]?.parentRevisionId;
  if (row.status === 'draft' && parentId && !isStructuredKind(row.document.kind) && (await svc.storage.headObject(row.s3Key))) {
    const text = await svc.storage.getObjectText(row.s3Key);
    const base = await svc.documents.getContent(documentId, parentId).catch(() => null);
    const kept = keepFrontmatter(text, base?.frontmatter);
    if (kept !== text) await svc.storage.putObjectText(row.s3Key, kept, row.contentType);
  }
  return svc.documents.finalizeRevision(documentId, revisionId);
}
