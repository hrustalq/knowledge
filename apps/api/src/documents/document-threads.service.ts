import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DeleteDocumentCommentResponse,
  DocumentThread,
  ListDocumentThreadsResponse,
  ReviewComment,
  ReviewThreadAnchor,
} from '@knowledge/contracts';
import type {
  DocumentComment as CommentRow,
  DocumentThread as ThreadRow,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AUTHOR_ID_STUB } from './merge-requests.service.js';
import type { CreateThreadDto } from './dto/merge-requests.dto.js';
import { validateThreadAnchor } from './review-anchor.js';
import { t } from '../i18n/t.js';

type ThreadWithComments = ThreadRow & { comments: CommentRow[] };

/**
 * Comments on the page (feature 15).
 *
 * The review discussion model, moved off the merge request and onto the
 * document: a resolvable thread holding a flat comment list, optionally pinned
 * to a passage by quote. Two differences from review threads, both deliberate:
 *
 * - There is no "open" gate. A page has no status to close, so comments stay
 *   writable for as long as the page exists.
 * - An anchor records the revision it was written against but is never
 *   invalidated by a new one. The reader's resolver re-finds the quote in
 *   whatever the current text is, and reports the thread outdated only when
 *   the passage is genuinely gone — which is the point of quoting instead of
 *   storing a line number.
 */
@Injectable()
export class DocumentThreadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async list(documentId: string): Promise<ListDocumentThreadsResponse> {
    await this.getDocumentOrThrow(documentId);
    const rows = await this.prisma.documentThread.findMany({
      where: { documentId },
      include: { comments: { orderBy: { createdAt: 'asc' } } },
      // Unresolved first, then oldest-first, so the comment list under the
      // page reads as a conversation and settled threads sink.
      orderBy: [{ resolved: 'asc' }, { createdAt: 'asc' }],
    });
    return { documentId, threads: rows.map((t) => this.toThread(t)) };
  }

  async createThread(
    documentId: string,
    dto: CreateThreadDto,
    authorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: DocumentThread }> {
    const doc = await this.getDocumentOrThrow(documentId);
    const anchor = dto.anchor ? validateThreadAnchor(dto.anchor) : null;

    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.documentThread.create({
        data: {
          documentId,
          resolvable: dto.resolvable ?? true,
          source: dto.source ?? 'human',
          anchorType: anchor?.type ?? null,
          anchor: anchor ?? undefined,
        },
      });
      await tx.documentComment.create({
        data: { threadId: created.id, authorId, body: dto.body },
      });
      return tx.documentThread.findUniqueOrThrow({
        where: { id: created.id },
        include: { comments: { orderBy: { createdAt: 'asc' } } },
      });
    });

    await this.recordActivity(doc, 'document.comment.created', thread.id, authorId, {
      anchored: anchor !== null,
    });
    return { thread: this.toThread(thread) };
  }

  async reply(
    documentId: string,
    threadId: string,
    body: string,
    authorId: string = AUTHOR_ID_STUB,
    replyToId?: string,
  ): Promise<{ thread: DocumentThread }> {
    const doc = await this.getDocumentOrThrow(documentId);
    const thread = await this.getThreadOrThrow(documentId, threadId);
    const replyTo = replyToId ? await this.requireCommentInThread(thread.id, replyToId) : null;

    await this.prisma.documentComment.create({
      data: { threadId: thread.id, authorId, body, replyToId: replyTo?.id ?? null },
    });
    await this.recordActivity(doc, 'document.comment.created', thread.id, authorId, {
      anchored: thread.anchorType !== null,
    });
    return { thread: await this.reload(thread.id) };
  }

  /** Rewrite a comment — its own author only (see the merge-request twin). */
  async editComment(
    documentId: string,
    threadId: string,
    commentId: string,
    body: string,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: DocumentThread }> {
    await this.getDocumentOrThrow(documentId);
    const thread = await this.getThreadOrThrow(documentId, threadId);
    const comment = await this.requireCommentInThread(thread.id, commentId);
    if (comment.authorId !== actorId) {
      throw new ForbiddenException(t('error.comment.onlyAuthorCanEdit'));
    }

    await this.prisma.documentComment.update({
      where: { id: comment.id },
      data: { body, updatedAt: new Date() },
    });
    return { thread: await this.reload(thread.id) };
  }

  /** Delete a comment — its own author only (see the merge-request twin). */
  async deleteComment(
    documentId: string,
    threadId: string,
    commentId: string,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<DeleteDocumentCommentResponse> {
    const doc = await this.getDocumentOrThrow(documentId);
    const thread = await this.getThreadOrThrow(documentId, threadId);
    const comment = await this.requireCommentInThread(thread.id, commentId);
    if (comment.authorId !== actorId) {
      throw new ForbiddenException(t('error.comment.onlyAuthorCanDelete'));
    }

    const remaining = await this.prisma.$transaction(async (tx) => {
      await tx.documentComment.delete({ where: { id: comment.id } });
      const left = await tx.documentComment.count({ where: { threadId: thread.id } });
      if (left === 0) await tx.documentThread.delete({ where: { id: thread.id } });
      return left;
    });

    await this.recordActivity(doc, 'document.comment.deleted', thread.id, actorId, {
      threadRemoved: remaining === 0,
    });
    return {
      threadId: thread.id,
      thread: remaining === 0 ? null : await this.reload(thread.id),
    };
  }

  async setResolved(
    documentId: string,
    threadId: string,
    resolved: boolean,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: DocumentThread }> {
    const doc = await this.getDocumentOrThrow(documentId);
    const thread = await this.getThreadOrThrow(documentId, threadId);
    if (!thread.resolvable) {
      throw new BadRequestException(
        t('error.thread.plainComment', { id: thread.id }),
      );
    }

    if (thread.resolved !== resolved) {
      await this.prisma.documentThread.update({
        where: { id: thread.id },
        data: resolved
          ? { resolved: true, resolvedBy: actorId, resolvedAt: new Date() }
          : { resolved: false, resolvedBy: null, resolvedAt: null },
      });
      await this.recordActivity(doc, 'document.comment.resolved', thread.id, actorId, { resolved });
    }
    return { thread: await this.reload(thread.id) };
  }

  private toThread(t: ThreadWithComments): DocumentThread {
    return {
      threadId: t.id,
      documentId: t.documentId,
      source: t.source === 'ai' ? 'ai' : 'human',
      resolvable: t.resolvable,
      resolved: t.resolved,
      resolvedBy: t.resolvedBy,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      anchor: (t.anchor as ReviewThreadAnchor | null) ?? null,
      comments: t.comments.map(
        (c): ReviewComment => ({
          commentId: c.id,
          threadId: c.threadId,
          authorId: c.authorId,
          body: c.body,
          replyToId: c.replyToId,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt?.toISOString() ?? null,
        }),
      ),
      createdAt: t.createdAt.toISOString(),
    };
  }

  private async reload(threadId: string): Promise<DocumentThread> {
    const row = await this.prisma.documentThread.findUniqueOrThrow({
      where: { id: threadId },
      include: { comments: { orderBy: { createdAt: 'asc' } } },
    });
    return this.toThread(row);
  }

  /** Fire-and-forget by contract: ActivityService.record never throws into the request. */
  private async recordActivity(
    doc: { id: string; workspaceId: string; title: string },
    action: string,
    threadId: string,
    actor: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record({
      workspaceId: doc.workspaceId,
      actor,
      action,
      documentId: doc.id,
      subjectId: threadId,
      metadata: { documentTitle: doc.title, threadId, ...metadata },
    });
  }

  private async getDocumentOrThrow(documentId: string) {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    return doc;
  }

  private async getThreadOrThrow(documentId: string, threadId: string) {
    const thread = await this.prisma.documentThread.findUnique({ where: { id: threadId } });
    if (!thread || thread.documentId !== documentId) {
      throw new NotFoundException(t('error.thread.notFoundOnDocument', { threadId, documentId }));
    }
    return thread;
  }

  private async requireCommentInThread(threadId: string, commentId: string) {
    const comment = await this.prisma.documentComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.threadId !== threadId) {
      throw new NotFoundException(t('error.comment.notFoundOnThread', { commentId, threadId }));
    }
    return comment;
  }
}
