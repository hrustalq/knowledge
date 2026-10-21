import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AUTHORABLE_RELATION_TYPES,
  CAPTURE_CLIENTS,
  CAPTURE_ITEM_MAX_CHARS,
  CAPTURE_KINDS,
  CAPTURE_LIST_MAX,
  CAPTURE_NOTE_KINDS,
  CAPTURE_PAGE_KIND_LIST,
  CAPTURE_SESSION_MAX_FILES,
  CAPTURE_STATUSES,
  CAPTURE_TITLE_MAX_CHARS,
  type CaptureSession,
} from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import type { AccessScope } from '../permissions/access-scope.js';
import type { CaptureService } from '../captures/capture.service.js';
import type { FlowsService } from '../flows/flows.service.js';
import { flowAnswersArg, runFlow } from './flow-tools.js';

/** What the capture tools need from `McpService.buildServer`: the caller, its guards and the reply shape. */
export interface CaptureToolDeps {
  captures: CaptureService;
  flows: FlowsService;
  principal: Principal;
  guard: {
    captureWs(workspaceId: string): Promise<void>;
    captureDoc(documentId: string): Promise<unknown>;
    ws(workspaceId: string, role: 'viewer'): Promise<void>;
    scope(workspaceId: string): Promise<AccessScope>;
  };
  workspaceOfDocument(documentId: string): Promise<string>;
  json(value: unknown): { content: Array<{ type: 'text'; text: string }> };
}

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (desc: string) => z.array(text(CAPTURE_ITEM_MAX_CHARS)).max(CAPTURE_LIST_MAX).optional().describe(desc);
const ids = (desc: string) => z.array(z.string().uuid()).max(CAPTURE_LIST_MAX).optional().describe(desc);

const session = z
  .object({
    client: z.enum(CAPTURE_CLIENTS).describe('The coding agent writing this'),
    clientVersion: z.string().max(100).optional(),
    sessionId: z.string().max(200).optional(),
    repo: z.string().max(300).optional().describe('owner/name or the remote URL, from `git remote get-url origin`'),
    branch: z.string().max(300).optional().describe('From `git rev-parse --abbrev-ref HEAD`'),
    commit: z.string().max(100).optional().describe('From `git rev-parse HEAD`'),
    files: z.array(z.string().max(500)).max(CAPTURE_SESSION_MAX_FILES).optional().describe('Repository paths the session touched — paths only'),
    startedAt: z.string().max(40).optional(),
  })
  .describe('Where this was learned. Never a transcript.');

const PROPOSES =
  'It is staged, deduplicated against existing pages and proposed as a merge request a person reviews — nothing ' +
  'changes until they merge it. Returns { captureId, state, outcome, mergeRequestId, webUrl, similar }: outcome ' +
  'new-page or amend-page (the closest page got a section), or state duplicate when the knowledge base already says it. ' +
  'Never include secrets, credentials or personal data; a capture carrying one is refused.';

/**
 * The agent-memory tools (issue #73). The five writes are CAPTURE_TOOLS: their
 * guards are `captureWs` / `captureDoc`, the only ones that let a `capture` key
 * reach editor, and every limit behind them is enforced in `CaptureService`.
 * The two reads are offered to every key.
 */
export function registerCaptureTools(server: McpServer, deps: CaptureToolDeps): void {
  const { captures, principal, guard, json } = deps;
  const run = async (fn: () => Promise<unknown>) => json(await fn());

  server.registerTool(
    'knowledge_capture_decision',
    {
      description:
        'Record a decision made in this session — what was chosen, why, and what was ruled out — so the next person or ' +
        `agent finds the reasoning, not just the code. ${PROPOSES} Without projectId it asks the person where the ` +
        'decision belongs — project, related page, reviewer — as status "needs_input" (or a form, where the client has one).',
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid().optional().describe('Omit to let the person pick the project, a related page and a reviewer'),
        title: text(CAPTURE_TITLE_MAX_CHARS).describe('The decision as a short statement, e.g. "Use RRF to fuse vector and BM25 search"'),
        context: text(20_000).describe('The problem and the forces at play'),
        decision: text(20_000).describe('What was decided and why'),
        consequences: z.string().max(20_000).optional().describe('What follows from it, good and bad'),
        alternatives: list('Options considered and why each was not chosen'),
        relatedDocumentIds: ids('Pages this decision relates to; without projectId, offered first as the related page'),
        session,
        answers: flowAnswersArg,
      },
    },
    async ({ workspaceId, projectId, title, context, decision, consequences, alternatives, relatedDocumentIds, session: s, answers }) => {
      await guard.captureWs(workspaceId);
      const args = {
        title,
        context,
        decision,
        ...(consequences ? { consequences } : {}),
        ...(alternatives ? { alternatives } : {}),
        ...(projectId ? { projectId } : {}),
        ...(relatedDocumentIds ? { relatedDocumentIds } : {}),
        session: s as CaptureSession,
      };
      return run(() =>
        runFlow(
          server,
          'knowledge_capture_decision',
          answers ?? {},
          (given) => deps.flows.captureDecision(principal, workspaceId, args, given),
          (done) => ({ ...done.result, ...(done.dropped.length ? { ignored: done.dropped } : {}) }),
        ),
      );
    },
  );

  server.registerTool(
    'knowledge_capture_note',
    {
      description:
        'Record something durable learned in this session: a gotcha (a non-obvious trap that cost time), a convention ' +
        `(how this team does a thing) or a how-to (steps that work). One fact per call. ${PROPOSES}`,
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid(),
        kind: z.enum(CAPTURE_NOTE_KINDS),
        title: text(CAPTURE_TITLE_MAX_CHARS),
        body: text(20_000).describe('Markdown. Say what is true and when it applies; no session narrative'),
        appliesTo: list('Repository paths or entity keys it is about'),
        session,
      },
    },
    async ({ workspaceId, projectId, kind, title, body, appliesTo, session: s }) => {
      await guard.captureWs(workspaceId);
      return run(() =>
        captures.capture(
          { kind, workspaceId, projectId, title, body, ...(appliesTo ? { appliesTo } : {}), session: s as CaptureSession },
          principal,
        ),
      );
    },
  );

  server.registerTool(
    'knowledge_propose_glossary_term',
    {
      description:
        'Propose a project term the team uses and a newcomer would not know. It waits in the captures inbox until an ' +
        'editor approves it; a term or alias the project already defines comes back as state duplicate. Returns ' +
        '{ captureId, state, outcome }.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid(),
        term: text(200),
        definition: text(4_000),
        aliases: list('Abbreviations and other spellings'),
        documentId: z.string().uuid().optional().describe('A page that defines the term in full'),
        session,
      },
    },
    async ({ workspaceId, projectId, term, definition, aliases, documentId, session: s }) => {
      await guard.captureWs(workspaceId);
      return run(() =>
        captures.capture(
          {
            kind: 'glossary',
            workspaceId,
            projectId,
            term,
            definition,
            ...(aliases ? { aliases } : {}),
            ...(documentId ? { documentId } : {}),
            session: s as CaptureSession,
          },
          principal,
        ),
      );
    },
  );

  server.registerTool(
    'knowledge_propose_relation',
    {
      description:
        "Propose a relation from a page to an entity found in this session (e.g. DEPENDS_ON service:billing), as a merge " +
        "request that edits only the page's frontmatter. A relation the page already declares comes back as state duplicate.",
      inputSchema: {
        documentId: z.string().uuid(),
        type: z.enum(AUTHORABLE_RELATION_TYPES),
        targetKey: text(300).describe('Entity key, e.g. "service:billing"'),
        rationale: text(2_000).describe('Why the relation holds — the reviewer reads this'),
        session,
      },
    },
    async ({ documentId, type, targetKey, rationale, session: s }) => {
      await guard.captureDoc(documentId);
      const workspaceId = await deps.workspaceOfDocument(documentId);
      return run(() =>
        captures.capture(
          { kind: 'relation', workspaceId, documentId, type, targetKey, rationale, session: s as CaptureSession },
          principal,
        ),
      );
    },
  );

  server.registerTool(
    'knowledge_propose_answer',
    {
      description:
        'Write a useful answer back to the knowledge base — one that took real digging to find — with the pages it ' +
        `stands on. citedDocumentIds is required. ${PROPOSES}`,
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid().optional().describe("Defaults to the first cited page's project"),
        title: z.string().max(CAPTURE_TITLE_MAX_CHARS).optional().describe('Defaults to the question'),
        question: text(4_000),
        answer: text(20_000),
        citedDocumentIds: z.array(z.string().uuid()).min(1).max(CAPTURE_LIST_MAX),
        session,
      },
    },
    async ({ workspaceId, projectId, title, question, answer, citedDocumentIds, session: s }) => {
      await guard.captureWs(workspaceId);
      return run(() =>
        captures.capture(
          {
            kind: 'answer',
            workspaceId,
            ...(projectId ? { projectId } : {}),
            ...(title?.trim() ? { title } : {}),
            question,
            answer,
            citedDocumentIds,
            session: s as CaptureSession,
          },
          principal,
        ),
      );
    },
  );

  server.registerTool(
    'knowledge_find_similar',
    {
      description:
        'Before capturing, check whether the knowledge base already says it: the pages nearest the text, by cosine ' +
        'similarity (0–1), only pages you can open. Pass the title and kind you will capture with, and the projectId, ' +
        'and text is scored exactly as that capture will be; the reply then carries decision — duplicate (the capture ' +
        'would propose nothing: skip it), amend (it would become a section of similar[0]) or new-page. Returns ' +
        '{ similar: [{ documentId, title, score }], decision? }.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        projectId: z.string().uuid().optional(),
        text: text(8_000).describe(
          "The capture's main text: a note's body; a decision's context, a newline, then the decision; an answer's " +
            'question, a newline, then the answer',
        ),
        title: z.string().trim().max(CAPTURE_TITLE_MAX_CHARS).optional().describe('The title you will capture with'),
        kind: z.enum(CAPTURE_PAGE_KIND_LIST).optional().describe('The kind you will capture as; with title, adds decision'),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ workspaceId, projectId, text: query, title, kind, limit }) => {
      await guard.ws(workspaceId, 'viewer');
      const scope = await guard.scope(workspaceId);
      return run(() =>
        captures.findSimilar(principal, scope, {
          text: query,
          ...(title ? { title } : {}),
          ...(kind ? { kind } : {}),
          ...(projectId ? { projectId } : {}),
          ...(limit ? { limit } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'knowledge_list_captures',
    {
      description:
        'Captures in a workspace, newest first, with where each went: state (staged | proposed | duplicate | rejected | ' +
        'failed | merged | closed), outcome, merge request and the pages it was compared with. mine=true for your own.',
      inputSchema: {
        workspaceId: z.string().uuid(),
        status: z.enum(CAPTURE_STATUSES).optional().describe('Stored status; merged/closed read from the merge request'),
        kind: z.enum(CAPTURE_KINDS).optional(),
        projectId: z.string().uuid().optional(),
        mine: z.boolean().optional(),
        cursor: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ workspaceId, status, kind, projectId, mine, cursor, limit }) => {
      await guard.ws(workspaceId, 'viewer');
      const scope = await guard.scope(workspaceId);
      return run(() =>
        captures.list(
          {
            workspaceId,
            ...(status ? { status } : {}),
            ...(kind ? { kind } : {}),
            ...(projectId ? { projectId } : {}),
            ...(mine ? { createdBy: principal.userId } : {}),
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit } : {}),
          },
          scope,
        ),
      );
    },
  );
}
