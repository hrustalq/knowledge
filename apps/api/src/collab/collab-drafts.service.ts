import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { prosemirrorToYDoc } from '@tiptap/y-tiptap';
import { BODY_FIELD, SCHEMA_VERSION, parseMarkdown } from '@knowledge/editor-schema';
import type { Env } from '../config/env.js';
import { DocumentsService } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export { BODY_FIELD };

/**
 * One document for every seed. jsdom runs no scripts and loads no resources by
 * default, so parsing a page's HTML here never executes or fetches anything;
 * the elements are only ever created, never attached.
 */
let seedDom: Document | undefined;

/** markdown → encoded Y.Doc, the way the editor opens the page (seeding option A, doc 56). */
export function seedState(markdown: string): Uint8Array<ArrayBuffer> {
  seedDom ??= new JSDOM('').window.document;
  // Copied into a plain ArrayBuffer, which is what Prisma's Bytes takes.
  return new Uint8Array(Y.encodeStateAsUpdate(prosemirrorToYDoc(parseMarkdown(markdown, seedDom), BODY_FIELD)));
}

/** A store would push the draft past COLLAB_MAX_DOC_BYTES. */
export class CollabDraftTooLargeError extends Error {}

/**
 * The shared draft of one (document, branch): its hot Y state in PG.
 * Revisions stay immutable; this row is the only mutable copy of a page.
 */
@Injectable()
export class CollabDraftsService {
  private readonly maxBytes: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {
    this.maxBytes = config.get('COLLAB_MAX_DOC_BYTES', { infer: true });
  }

  /** The workspace a (document, branch) pair belongs to, or null when the branch is not that document's. */
  async workspaceOfBranch(documentId: string, branchId: string): Promise<string | null> {
    const branch = await this.prisma.documentBranch.findFirst({
      where: { id: branchId, documentId },
      select: { document: { select: { workspaceId: true } } },
    });
    return branch?.document.workspaceId ?? null;
  }

  /**
   * The draft's state, seeded once from the branch head on first use.
   *
   * Every instance with a peer runs this independently, so two can seed at
   * once. The insert is guarded (`ON CONFLICT DO NOTHING` on the unique
   * pair) and everyone then adopts the row that won: two seeds merged into
   * one Y.Doc would show the page twice.
   */
  async load(workspaceId: string, documentId: string, branchId: string): Promise<Uint8Array> {
    const where = { documentId_branchId: { documentId, branchId } };
    const existing = await this.prisma.collabDraft.findUnique({ where, select: { state: true } });
    if (existing) return existing.state;

    const branch = await this.prisma.documentBranch.findUniqueOrThrow({
      where: { id: branchId },
      select: { headRevisionId: true },
    });
    const head = branch.headRevisionId;
    const state = seedState(head ? (await this.documents.getContent(documentId, head)).markdown : '');
    await this.prisma.collabDraft.createMany({
      data: [
        {
          workspaceId,
          documentId,
          branchId,
          baseRevisionId: head,
          state,
          stateBytes: state.byteLength,
          schemaVersion: SCHEMA_VERSION,
        },
      ],
      skipDuplicates: true,
    });
    return (await this.prisma.collabDraft.findUniqueOrThrow({ where, select: { state: true } })).state;
  }

  /**
   * Persist the full state and credit the writer. One statement: the
   * contributor is appended only if absent, so concurrent stores cannot
   * duplicate it.
   */
  async store(documentId: string, branchId: string, state: Uint8Array, userId?: string): Promise<void> {
    if (state.byteLength > this.maxBytes) throw new CollabDraftTooLargeError();
    const writer = userId ? JSON.stringify(userId) : null;
    await this.prisma.$executeRaw`
      UPDATE collab_drafts SET
        state = ${state},
        state_bytes = ${state.byteLength},
        last_edited_by = COALESCE(${userId ?? null}::uuid, last_edited_by),
        contributors = CASE
          WHEN ${writer}::jsonb IS NULL OR contributors @> jsonb_build_array(${writer}::jsonb) THEN contributors
          ELSE contributors || jsonb_build_array(${writer}::jsonb)
        END,
        updated_at = now()
      WHERE document_id = ${documentId}::uuid AND branch_id = ${branchId}::uuid`;
  }
}
