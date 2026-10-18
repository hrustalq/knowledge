import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { prosemirrorToYDoc } from '@tiptap/y-tiptap';
import type { CollabDraftInfo } from '@knowledge/contracts';
import { BODY_FIELD, SCHEMA_VERSION, parseMarkdown } from '@knowledge/editor-schema';
import { pageMetaOf, seedPageMeta, type PageMeta } from '@knowledge/editor-schema/page-fields';
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

/** A Y snapshot (state vector + delete set), encoded — what "unpublished" compares. */
export function snapshotOf(doc: Y.Doc): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Y.encodeSnapshot(Y.snapshot(doc)));
}

/**
 * Whether two encoded snapshots name the same state. Decoded, not byte-equal:
 * the state vector's encoding follows the order clients joined a doc, which a
 * browser and the server need not share.
 */
export function sameSnapshot(a: Uint8Array, b: Uint8Array): boolean {
  return Y.equalSnapshots(Y.decodeSnapshot(a), Y.decodeSnapshot(b));
}

/**
 * markdown → encoded Y.Doc, the way the editor opens the page (seeding option
 * A, doc 56), with the page's fields beside the body when they are known.
 */
export function seedState(markdown: string, meta?: PageMeta): { state: Uint8Array<ArrayBuffer>; snapshot: Uint8Array<ArrayBuffer> } {
  seedDom ??= new JSDOM('').window.document;
  const doc = prosemirrorToYDoc(parseMarkdown(markdown, seedDom), BODY_FIELD);
  if (meta) seedPageMeta(doc, meta);
  // Copied into a plain ArrayBuffer, which is what Prisma's Bytes takes.
  return { state: new Uint8Array(Y.encodeStateAsUpdate(doc)), snapshot: snapshotOf(doc) };
}

/** A store would push the draft past COLLAB_MAX_DOC_BYTES. */
export class CollabDraftTooLargeError extends Error {}

/** A draft as loaded: its row, its state, and which reset it belongs to (a store from before a reset is refused). */
export interface LoadedDraft {
  id: string;
  state: Uint8Array;
  resetAt: Date | null;
}

/**
 * The shared draft of one (document, branch): its hot Y state in PG.
 * Revisions stay immutable; this row is the only mutable copy of a page.
 * Publishing it rebases it in `DocumentsService.finalizeRevision`.
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
  async load(workspaceId: string, documentId: string, branchId: string): Promise<LoadedDraft> {
    const where = { documentId_branchId: { documentId, branchId } };
    const select = { id: true, state: true, resetAt: true } as const;
    const existing = await this.prisma.collabDraft.findUnique({ where, select });
    if (existing) return existing;

    const { head, state, snapshot } = await this.seedFromHead(documentId, branchId);
    await this.prisma.collabDraft.createMany({
      data: [
        {
          workspaceId,
          documentId,
          branchId,
          baseRevisionId: head,
          state,
          stateBytes: state.byteLength,
          snapshot,
          publishedSnapshot: snapshot,
          schemaVersion: SCHEMA_VERSION,
        },
      ],
      skipDuplicates: true,
    });
    return this.prisma.collabDraft.findUniqueOrThrow({ where, select });
  }

  /**
   * Persist the full state and credit the writer. One statement: the
   * contributor is appended only if absent, so concurrent stores cannot
   * duplicate it. Refused (false) when the row is not the one this state was
   * loaded from — reset since, or dropped and seeded anew — so an instance
   * still holding the old doc cannot write it back over the reseed.
   */
  async store(loaded: Omit<LoadedDraft, 'state'>, draft: { state: Uint8Array; snapshot: Uint8Array; userId?: string }): Promise<boolean> {
    const { state, snapshot, userId } = draft;
    if (state.byteLength > this.maxBytes) throw new CollabDraftTooLargeError();
    const writer = userId ? JSON.stringify(userId) : null;
    const updated = await this.prisma.$executeRaw`
      UPDATE collab_drafts SET
        state = ${state},
        state_bytes = ${state.byteLength},
        snapshot = ${snapshot},
        last_edited_by = COALESCE(${userId ?? null}::uuid, last_edited_by),
        contributors = CASE
          WHEN ${writer}::jsonb IS NULL OR contributors @> jsonb_build_array(${writer}::jsonb) THEN contributors
          ELSE contributors || jsonb_build_array(${writer}::jsonb)
        END,
        updated_at = now()
      WHERE id = ${loaded.id}::uuid AND reset_at IS NOT DISTINCT FROM ${loaded.resetAt}::timestamptz`;
    return updated > 0;
  }

  /**
   * Discard the draft: reseed it from the branch head in place. `reset_at`
   * moves (to a millisecond, so the value read back compares equal), which
   * is what refuses every store from a doc loaded before it. The caller
   * closes the open peers. False when the branch had no draft.
   */
  async reset(documentId: string, branchId: string): Promise<boolean> {
    const { head, state, snapshot } = await this.seedFromHead(documentId, branchId);
    const { count } = await this.prisma.collabDraft.updateMany({
      where: { documentId, branchId },
      data: {
        baseRevisionId: head,
        state,
        stateBytes: state.byteLength,
        snapshot,
        publishedSnapshot: snapshot,
        schemaVersion: SCHEMA_VERSION,
        contributors: [],
        lastEditedBy: null,
        resetAt: new Date(),
      },
    });
    return count > 0;
  }

  /** Every branch's draft of a document. `peers` counts who has one open. */
  async list(documentId: string, peers: (workspaceId: string, branchId: string) => number): Promise<CollabDraftInfo[]> {
    const rows = await this.prisma.collabDraft.findMany({
      where: { documentId },
      select: {
        id: true,
        workspaceId: true,
        branchId: true,
        baseRevisionId: true,
        snapshot: true,
        publishedSnapshot: true,
        contributors: true,
        updatedAt: true,
        branch: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => {
      const contributors = (row.contributors as string[]) ?? [];
      return {
        draftId: row.id,
        branchId: row.branchId,
        branch: row.branch.name,
        baseRevisionId: row.baseRevisionId,
        hasUnpublishedChanges: hasUnpublished(row.snapshot, row.publishedSnapshot, contributors),
        contributors,
        activePeers: peers(row.workspaceId, row.branchId),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Drafts edited since their last checkpoint, whose last checkpoint is older
   * than the interval. The caller claims each with `claimCheckpoint`.
   */
  dueForCheckpoint(intervalMinutes: number, limit: number) {
    return this.prisma.$queryRaw<
      { id: string; workspace_id: string; document_id: string; branch_id: string; last_checkpoint_at: Date | null }[]
    >`
      SELECT id, workspace_id, document_id, branch_id, last_checkpoint_at FROM collab_drafts
      WHERE updated_at > COALESCE(last_checkpoint_at, '-infinity')
        AND COALESCE(last_checkpoint_at, '-infinity') < now() - make_interval(mins => ${intervalMinutes}::int)
      ORDER BY updated_at
      LIMIT ${limit}`;
  }

  /**
   * Take the checkpoint for one draft: one guarded statement, so of several
   * API instances sweeping at once exactly one writes it. Raw, so
   * `updated_at` (the "edited since" side of the due check) does not move.
   * Returns the state to copy, or null when another instance won.
   */
  async claimCheckpoint(id: string, previous: Date | null): Promise<Uint8Array | null> {
    const rows = await this.prisma.$queryRaw<{ state: Uint8Array }[]>`
      UPDATE collab_drafts SET last_checkpoint_at = now()
      WHERE id = ${id}::uuid AND last_checkpoint_at IS NOT DISTINCT FROM ${previous}::timestamptz
      RETURNING state`;
    return rows[0]?.state ?? null;
  }

  /**
   * Drop drafts that hold nothing unpublished and nobody touched for
   * `days`. A draft with unpublished changes is never dropped. One that is
   * open somewhere reseeds as an identical page: its next store is refused
   * and its peers rejoin (`reset`).
   */
  async dropIdle(days: number): Promise<number> {
    const before = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.collabDraft.findMany({
      where: { updatedAt: { lt: before } },
      select: { id: true, snapshot: true, publishedSnapshot: true, contributors: true, updatedAt: true },
      take: 200,
    });
    const idle = rows.filter((r) => !hasUnpublished(r.snapshot, r.publishedSnapshot, (r.contributors as string[]) ?? []));
    let dropped = 0;
    for (const row of idle) {
      // Guarded on the timestamp read: a store since then keeps the draft.
      dropped += (await this.prisma.collabDraft.deleteMany({ where: { id: row.id, updatedAt: row.updatedAt } })).count;
    }
    return dropped;
  }

  /** The branch head's page as a fresh draft: body and fields, the way the editor opens it. */
  private async seedFromHead(documentId: string, branchId: string) {
    const branch = await this.prisma.documentBranch.findUniqueOrThrow({
      where: { id: branchId },
      select: {
        headRevisionId: true,
        document: { select: { title: true, category: true, parentId: true, projectId: true } },
      },
    });
    const head = branch.headRevisionId;
    const content = head ? await this.documents.getContent(documentId, head) : null;
    const meta = pageMetaOf(branch.document, content?.frontmatter);
    return { head, ...seedState(content?.markdown ?? '', meta) };
  }
}

/**
 * The draft differs from what was last published or seeded. A row stored
 * before snapshots existed falls back to "someone wrote since the publish".
 */
function hasUnpublished(snapshot: Uint8Array | null, published: Uint8Array | null, contributors: string[]): boolean {
  if (!snapshot || !published) return contributors.length > 0;
  return !sameSnapshot(snapshot, published);
}
