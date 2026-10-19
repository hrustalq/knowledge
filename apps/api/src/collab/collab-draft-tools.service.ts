import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';
import { prosemirrorToYDoc, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { DRAFT_EDIT_OPS, type AssistantDraftEdit } from '@knowledge/contracts';
import { BODY_FIELD, editorSchema } from '@knowledge/editor-schema';
import { readPageMeta } from '@knowledge/editor-schema/page-fields';
import { docToMarkdown } from '@knowledge/editor-schema/serialize';
import {
  blockIndex,
  blockStart,
  markdownToFragment,
  normalizeQuote,
  targetRange,
  withoutSuggestions,
  type SuggestionEntry,
} from '@knowledge/editor-schema/suggestions';
import { readSuggestionEntries, writeSuggestionEntry } from '@knowledge/editor-schema/suggestion-entries';
import { refuseDraftEdit } from '../assistant/draft-edits.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollabDraftsService, serverDocument } from './collab-drafts.service.js';
import { CollabGateway } from './collab.gateway.js';

/** One pending suggestion, as an MCP client is shown it. */
export interface DraftSuggestionView {
  id: string;
  agent: string | null;
  requestedBy: string | null;
  state: 'streaming' | 'ready';
  /** The suggested blocks as markdown; empty for a suggested deletion. */
  markdown: string;
  /** Plain text of what it replaces; empty for an insertion. */
  replaces: string;
}

export interface DraftView {
  documentId: string;
  branch: string;
  draftId: string;
  /** The revision the draft was seeded from or last published as. */
  baseRevisionId: string | null;
  headRevisionId: string | null;
  /** Published another way since: publishing the draft as it stands would undo that revision. */
  headMoved: boolean;
  unpublished: boolean;
  /** People with the draft open now. */
  editing: number;
  title: string;
  category: string;
  tags: string;
  /** The body as publishing it would write it: pending suggestions are left out. */
  markdown: string;
  suggestions: DraftSuggestionView[];
}

/** The edit shape `edit_draft` takes in the editor (docs/features/34). */
export type DraftEdit = Pick<AssistantDraftEdit, 'op' | 'anchor' | 'markdown'>;

/**
 * A page's shared draft for the MCP draft tools (#316): read it as the
 * editor would publish it, and leave a suggestion in it every co-editor sees
 * at once, with Keep and Discard. API-only, like the gateway it writes
 * through; the HTTP MCP controller hands it to `McpService`, and the stdio
 * server, which has no gateway, never offers these tools.
 *
 * Access is the caller's: the tool handler's `guard.doc` has already asked
 * the page permissions (view to read, edit to suggest) when this runs.
 */
@Injectable()
export class CollabDraftToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: CollabDraftsService,
    private readonly gateway: CollabGateway,
  ) {}

  get enabled(): boolean {
    return this.gateway.hocuspocus !== null;
  }

  /** The draft, or null when the branch has none — read never creates one. */
  async read(documentId: string, branchName: string | undefined): Promise<DraftView | null> {
    const branch = await this.branchOf(documentId, branchName);
    const info = (await this.drafts.list(documentId, (ws, id) => this.gateway.peersOf(ws, documentId, id))).find(
      (d) => d.branchId === branch.id,
    );
    if (!info) return null;
    // ponytail: a peer on another instance can be ahead of the row by COLLAB_STORE_MAX_DEBOUNCE_MS; read through Redis if that bites.
    let doc = this.gateway.loadedDraft(branch.workspaceId, documentId, branch.id);
    if (!doc) {
      const row = await this.prisma.collabDraft.findUniqueOrThrow({
        where: { documentId_branchId: { documentId, branchId: branch.id } },
        select: { state: true },
      });
      doc = new Y.Doc();
      Y.applyUpdate(doc, row.state);
    }
    const body = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(BODY_FIELD), editorSchema);
    const entries = readSuggestionEntries(doc);
    const writers = (doc as Partial<{ awareness: { getStates(): Map<number, unknown> } }>).awareness?.getStates();
    const meta = readPageMeta(doc);
    return {
      documentId,
      branch: branch.name,
      draftId: info.draftId,
      baseRevisionId: info.baseRevisionId,
      headRevisionId: branch.headRevisionId,
      headMoved: info.baseRevisionId !== branch.headRevisionId,
      unpublished: info.hasUnpublishedChanges,
      editing: info.activePeers,
      title: meta.texts.title,
      category: meta.values.category,
      tags: meta.texts.tags,
      markdown: markdownOf(withoutSuggestions(body, entries)),
      suggestions: entries.map((entry) => ({
        id: entry.id,
        agent: entry.agent?.name ?? null,
        requestedBy: entry.requestedBy?.name ?? null,
        // A streaming suggestion whose writer has left is finished, as the editor reads it.
        state: entry.state === 'streaming' && writers?.has(entry.clientId) ? 'streaming' : 'ready',
        markdown: markdownOf(sliceDoc(body, blockStart(body, entry.fromIndex), blockStart(body, entry.toIndex))),
        replaces: entry.originalText,
      })),
    };
  }

  /**
   * Write `edit` into the draft as a ready suggestion, credited to the
   * calling key for its person. Refused, writing nothing, for the reasons the
   * editor's assistant is refused (`refuseDraftEdit`, against the draft
   * without its pending suggestions — the text `read` returns), and when it
   * would land inside a suggestion still waiting for a decision. A branch
   * without a draft gets one, seeded from its head.
   */
  async suggest(principal: Principal, documentId: string, branchName: string | undefined, edit: DraftEdit): Promise<{ suggestionId: string; branch: string }> {
    const branch = await this.branchOf(documentId, branchName);
    const agent = { key: 'mcp', name: (await this.keyName(principal)) ?? 'MCP' };
    const requestedBy = { userId: principal.userId, name: principal.displayName };
    const id = randomUUID();
    const refusal = await this.gateway.writeDraft(branch.workspaceId, documentId, branch.id, (doc) => {
      const body = doc.getXmlFragment(BODY_FIELD);
      const pm = yXmlFragmentToProseMirrorRootNode(body, editorSchema);
      const entries = readSuggestionEntries(doc);
      const refused = refuseDraftEdit(markdownOf(withoutSuggestions(pm, entries)), { ...edit, anchor: edit.anchor ?? null }, DRAFT_EDIT_OPS);
      if (refused) return refused;

      const range = targetRange(pm, edit, serverDocument());
      const fromIndex = blockIndex(pm, range.from, 'down');
      const toIndex = blockIndex(pm, range.to, 'up');
      // Discarding the older one would put its text back over this one.
      if (entries.some((e) => overlaps(fromIndex, toIndex, e))) return 'the edit falls inside a suggestion that is still waiting for a decision — keep or discard it first';

      const blocks = yBlocks(markdownToFragment(edit.markdown, editorSchema, serverDocument()));
      body.delete(fromIndex, toIndex - fromIndex);
      body.insert(fromIndex, blocks);
      writeSuggestionEntry(
        doc,
        {
          id,
          fromIndex,
          toIndex: fromIndex + blocks.length,
          original: pm.slice(blockStart(pm, fromIndex), blockStart(pm, toIndex)).toJSON(),
          originalText: normalizeQuote(pm.textBetween(blockStart(pm, fromIndex), blockStart(pm, toIndex), ' ')),
          state: 'ready',
          agent,
        },
        requestedBy,
      );
      return null;
    });
    if (refusal) throw new BadRequestException({ statusCode: 400, message: refusal, reason: 'draft-edit-refused' });
    return { suggestionId: id, branch: branch.name };
  }

  /** The named branch of the page, or its default one. */
  private async branchOf(documentId: string, name: string | undefined) {
    const document = await this.prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { workspaceId: true, defaultBranch: true } });
    const branchName = name ?? document.defaultBranch;
    const branch = await this.prisma.documentBranch.findFirst({
      where: { documentId, name: branchName },
      select: { id: true, name: true, headRevisionId: true },
    });
    if (!branch) throw new NotFoundException(t('error.collab.branchNotFound', { documentId, branch: branchName }));
    return { ...branch, workspaceId: document.workspaceId };
  }

  private async keyName(principal: Principal): Promise<string | null> {
    if (!principal.apiKey) return null;
    const key = await this.prisma.apiKey.findUnique({ where: { id: principal.apiKey.id }, select: { name: true } });
    return key?.name || null;
  }
}

/**
 * Whether blocks [from, to) — a point when equal — reach inside a pending
 * suggestion. Touching one's edge does not: inserting just before a
 * suggestion, or replacing the block after it, leaves it whole.
 */
export function overlaps(from: number, to: number, entry: Pick<SuggestionEntry, 'fromIndex' | 'toIndex'>): boolean {
  const { fromIndex: a, toIndex: b } = entry;
  if (from === to) return a < from && from < b;
  if (a === b) return from < a && a < to;
  return from < b && a < to;
}

/** A ProseMirror document, as y-tiptap hands it back (the API has no direct @tiptap/pm). */
type PMNode = ReturnType<typeof yXmlFragmentToProseMirrorRootNode>;

const markdownOf = (doc: PMNode) => docToMarkdown(doc, editorSchema, serverDocument());

function sliceDoc(doc: PMNode, from: number, to: number): PMNode {
  return editorSchema.topNodeType.create(null, doc.slice(from, to).content);
}

/** Top-level Y elements for `content`, in the encoding the editor's binding reads. */
function yBlocks(content: PMNode['content']): (Y.XmlElement | Y.XmlText)[] {
  if (content.childCount === 0) return [];
  const scratch = prosemirrorToYDoc(editorSchema.topNodeType.create(null, content), BODY_FIELD);
  return scratch.getXmlFragment(BODY_FIELD).toArray().map((node) => (node as Y.XmlElement | Y.XmlText).clone());
}
