import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DeleteMergeRequestCommentResponse,
  ListMergeRequestThreadsResponse,
  MergeRequestComment,
  MergeRequestThread,
  MergeRequestThreadAnchor,
} from '@knowledge/contracts';
import type {
  MergeRequestComment as CommentRow,
  MergeRequestThread as ThreadRow,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AUTHOR_ID_STUB, MergeRequestsService } from './merge-requests.service.js';
import type { CreateThreadDto } from './dto/merge-requests.dto.js';
import { MentionRepliesService } from './mention-replies.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { validateThreadAnchor } from './review-anchor.js';
import { currentLocale, t } from '../i18n/t.js';

type ThreadWithComments = ThreadRow & { comments: CommentRow[] };

/**
 * Review discussions on merge requests (plan.md §8): threads carry the anchor
 * and resolved state; comments inside a thread are a flat, createdAt-ordered
 * list (GitLab discussion model, no reply nesting).
 *
 * Anchors are best-effort: a line anchor pins the source-head revision at
 * comment time — once that branch advances the client shows the thread as
 * "outdated" instead of re-anchoring it (server-side re-anchoring is future
 * work).
 */
@Injectable()
export class MergeRequestThreadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly mentions: MentionRepliesService,
    private readonly notifications: NotificationsService,
    // See DocumentThreadsService: NotificationsService cannot publish, so the
    // frames for directed notifications are announced from here.
    private readonly events: EventsPublisher,
  ) {}

  /** Threads are readable on merged/closed MRs too — only writes require `open`. */
  async list(mergeRequestId: string): Promise<ListMergeRequestThreadsResponse> {
    await this.getMrOrThrow(mergeRequestId);
    const rows = await this.prisma.mergeRequestThread.findMany({
      where: { mergeRequestId },
      include: { comments: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ resolved: 'asc' }, { createdAt: 'asc' }],
    });
    return { mergeRequestId, threads: rows.map((t) => this.toThread(t)) };
  }

  async createThread(
    mergeRequestId: string,
    dto: CreateThreadDto,
    authorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: MergeRequestThread }> {
    const mr = await this.getOpenMrOrThrow(mergeRequestId);
    const anchor = dto.anchor ? validateThreadAnchor(dto.anchor) : null;

    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.mergeRequestThread.create({
        data: {
          mergeRequestId,
          resolvable: dto.resolvable ?? true,
          source: dto.source ?? 'human',
          anchorType: anchor?.type ?? null,
          anchor: anchor ?? undefined,
        },
      });
      await tx.mergeRequestComment.create({
        data: { threadId: created.id, authorId, body: dto.body },
      });
      return tx.mergeRequestThread.findUniqueOrThrow({
        where: { id: created.id },
        include: { comments: { orderBy: { createdAt: 'asc' } } },
      });
    });

    const page = await this.mergeRequests.recordActivity(
      mr.documentId,
      'merge-request.comment.created',
      mr.id,
      authorId,
      { title: mr.title, threadId: thread.id, anchored: anchor !== null },
    );
    await this.mentions.handleMention({
      subject: { kind: 'merge-request', mergeRequestId: mr.id, documentId: mr.documentId },
      threadId: thread.id,
      body: dto.body,
      documentId: mr.documentId,
      actorId: authorId,
      locale: currentLocale(),
    });
    if (page) {
      const delivered = await this.notifications.onCommentPosted({
        workspaceId: page.workspaceId,
        subjectType: 'merge-request',
        subjectId: mr.id,
        documentId: mr.documentId,
        title: mr.title,
        body: dto.body,
        actorId: authorId,
        type: 'merge-request.comment.created',
        metadata: { threadId: thread.id },
      });
      await this.events.announce(page.workspaceId, delivered);
    }
    return { thread: await this.reload(thread.id) };
  }

  async reply(
    mergeRequestId: string,
    threadId: string,
    body: string,
    authorId: string = AUTHOR_ID_STUB,
    replyToId?: string,
  ): Promise<{ thread: MergeRequestThread }> {
    const mr = await this.getOpenMrOrThrow(mergeRequestId);
    const thread = await this.getThreadOrThrow(mergeRequestId, threadId);
    const replyTo = replyToId ? await this.requireCommentInThread(thread.id, replyToId) : null;

    await this.prisma.mergeRequestComment.create({
      data: { threadId: thread.id, authorId, body, replyToId: replyTo?.id ?? null },
    });
    const page = await this.mergeRequests.recordActivity(
      mr.documentId,
      'merge-request.comment.created',
      mr.id,
      authorId,
      { title: mr.title, threadId: thread.id, anchored: thread.anchorType !== null },
    );
    await this.mentions.handleMention({
      subject: { kind: 'merge-request', mergeRequestId: mr.id, documentId: mr.documentId },
      threadId: thread.id,
      body,
      documentId: mr.documentId,
      actorId: authorId,
      locale: currentLocale(),
    });
    if (page) {
      const delivered = await this.notifications.onCommentPosted({
        workspaceId: page.workspaceId,
        subjectType: 'merge-request',
        subjectId: mr.id,
        documentId: mr.documentId,
        title: mr.title,
        body: body,
        actorId: authorId,
        type: 'merge-request.comment.created',
        metadata: { threadId: thread.id },
      });
      await this.events.announce(page.workspaceId, delivered);
    }
    return { thread: await this.reload(thread.id) };
  }

  /**
   * Rewrite a comment. Only its own author may — a discussion is a record of
   * who said what, and letting a reviewer restate someone else's point would
   * make it a worthless one.
   */
  async editComment(
    mergeRequestId: string,
    threadId: string,
    commentId: string,
    body: string,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: MergeRequestThread }> {
    await this.getOpenMrOrThrow(mergeRequestId);
    const thread = await this.getThreadOrThrow(mergeRequestId, threadId);
    const comment = await this.requireCommentInThread(thread.id, commentId);
    if (comment.authorId !== actorId) {
      throw new ForbiddenException(t('error.comment.onlyAuthorCanEdit'));
    }

    await this.prisma.mergeRequestComment.update({
      where: { id: comment.id },
      data: { body, updatedAt: new Date() },
    });
    return { thread: await this.reload(thread.id) };
  }

  /**
   * Delete a comment. Author-only, for the same reason editing is.
   *
   * A thread whose last comment goes has nothing left to be a discussion
   * about, so it goes with it and the client drops the card instead of
   * rendering an empty one. Replies that pointed at the deleted comment stay
   * where they are and lose their attribution (the FK is ON DELETE SET NULL) —
   * removing them would delete other people's words.
   */
  async deleteComment(
    mergeRequestId: string,
    threadId: string,
    commentId: string,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<DeleteMergeRequestCommentResponse> {
    const mr = await this.getOpenMrOrThrow(mergeRequestId);
    const thread = await this.getThreadOrThrow(mergeRequestId, threadId);
    const comment = await this.requireCommentInThread(thread.id, commentId);
    if (comment.authorId !== actorId) {
      throw new ForbiddenException(t('error.comment.onlyAuthorCanDelete'));
    }

    const remaining = await this.prisma.$transaction(async (tx) => {
      await tx.mergeRequestComment.delete({ where: { id: comment.id } });
      const left = await tx.mergeRequestComment.count({ where: { threadId: thread.id } });
      if (left === 0) await tx.mergeRequestThread.delete({ where: { id: thread.id } });
      return left;
    });

    await this.mergeRequests.recordActivity(mr.documentId, 'merge-request.comment.deleted', mr.id, actorId, {
      title: mr.title,
      threadId: thread.id,
      threadRemoved: remaining === 0,
    });
    return {
      threadId: thread.id,
      thread: remaining === 0 ? null : await this.reload(thread.id),
    };
  }

  async setResolved(
    mergeRequestId: string,
    threadId: string,
    resolved: boolean,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: MergeRequestThread }> {
    const mr = await this.getOpenMrOrThrow(mergeRequestId);
    const thread = await this.getThreadOrThrow(mergeRequestId, threadId);
    if (!thread.resolvable) {
      throw new BadRequestException(
        t('error.thread.plainComment', { id: thread.id }),
      );
    }

    if (thread.resolved !== resolved) {
      await this.prisma.mergeRequestThread.update({
        where: { id: thread.id },
        data: resolved
          ? { resolved: true, resolvedBy: actorId, resolvedAt: new Date() }
          : { resolved: false, resolvedBy: null, resolvedAt: null },
      });
      await this.mergeRequests.recordActivity(mr.documentId, 'merge-request.comment.resolved', mr.id, actorId, {
        title: mr.title,
        threadId: thread.id,
        resolved,
      });
    }
    return { thread: await this.reload(thread.id) };
  }

  private toThread(t: ThreadWithComments): MergeRequestThread {
    return {
      threadId: t.id,
      mergeRequestId: t.mergeRequestId,
      source: t.source === 'ai' ? 'ai' : 'human',
      resolvable: t.resolvable,
      resolved: t.resolved,
      resolvedBy: t.resolvedBy,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      anchor: (t.anchor as MergeRequestThreadAnchor | null) ?? null,
      comments: t.comments.map(
        (c): MergeRequestComment => ({
          commentId: c.id,
          threadId: c.threadId,
          authorId: c.authorId,
          body: c.body,
          replyToId: c.replyToId,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt?.toISOString() ?? null,
          agentKey: c.agentKey,
          pending: c.pending,
        }),
      ),
      createdAt: t.createdAt.toISOString(),
    };
  }

  private async reload(threadId: string): Promise<MergeRequestThread> {
    const row = await this.prisma.mergeRequestThread.findUniqueOrThrow({
      where: { id: threadId },
      include: { comments: { orderBy: { createdAt: 'asc' } } },
    });
    return this.toThread(row);
  }

  private async getMrOrThrow(mergeRequestId: string) {
    const mr = await this.prisma.mergeRequest.findUnique({ where: { id: mergeRequestId } });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    return mr;
  }

  private async getOpenMrOrThrow(mergeRequestId: string) {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(
        t('error.mergeRequest.discussionsReadOnly', { id: mr.id, status: t(`status.mr.${mr.status}`) }),
      );
    }
    return mr;
  }

  private async getThreadOrThrow(mergeRequestId: string, threadId: string) {
    const thread = await this.prisma.mergeRequestThread.findUnique({ where: { id: threadId } });
    if (!thread || thread.mergeRequestId !== mergeRequestId) {
      throw new NotFoundException(t('error.thread.notFoundOnMergeRequest', { threadId, mergeRequestId }));
    }
    return thread;
  }

  private async requireCommentInThread(threadId: string, commentId: string) {
    const comment = await this.prisma.mergeRequestComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.threadId !== threadId) {
      throw new NotFoundException(t('error.comment.notFoundOnThread', { commentId, threadId }));
    }
    return comment;
  }
}
