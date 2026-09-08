import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
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
import { validateThreadAnchor } from './review-anchor.js';

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

    await this.mergeRequests.recordActivity(mr.documentId, 'merge-request.comment.created', mr.id, authorId, {
      title: mr.title,
      threadId: thread.id,
      anchored: anchor !== null,
    });
    return { thread: this.toThread(thread) };
  }

  async reply(
    mergeRequestId: string,
    threadId: string,
    body: string,
    authorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: MergeRequestThread }> {
    const mr = await this.getOpenMrOrThrow(mergeRequestId);
    const thread = await this.getThreadOrThrow(mergeRequestId, threadId);

    await this.prisma.mergeRequestComment.create({
      data: { threadId: thread.id, authorId, body },
    });
    await this.mergeRequests.recordActivity(mr.documentId, 'merge-request.comment.created', mr.id, authorId, {
      title: mr.title,
      threadId: thread.id,
      anchored: thread.anchorType !== null,
    });
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
    const comment = await this.prisma.mergeRequestComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.threadId !== thread.id) {
      throw new NotFoundException(`Comment ${commentId} not found on thread ${threadId}`);
    }
    if (comment.authorId !== actorId) {
      throw new ForbiddenException('Only the author of a comment can edit it');
    }

    await this.prisma.mergeRequestComment.update({
      where: { id: comment.id },
      data: { body, updatedAt: new Date() },
    });
    return { thread: await this.reload(thread.id) };
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
        `Thread ${thread.id} is a plain comment — only a thread can be resolved`,
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
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt?.toISOString() ?? null,
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
    if (!mr) throw new NotFoundException(`Merge request ${mergeRequestId} not found`);
    return mr;
  }

  private async getOpenMrOrThrow(mergeRequestId: string) {
    const mr = await this.getMrOrThrow(mergeRequestId);
    if (mr.status !== 'open') {
      throw new BadRequestException(
        `Merge request ${mr.id} is ${mr.status} — discussions are read-only once it leaves open`,
      );
    }
    return mr;
  }

  private async getThreadOrThrow(mergeRequestId: string, threadId: string) {
    const thread = await this.prisma.mergeRequestThread.findUnique({ where: { id: threadId } });
    if (!thread || thread.mergeRequestId !== mergeRequestId) {
      throw new NotFoundException(`Thread ${threadId} not found on merge request ${mergeRequestId}`);
    }
    return thread;
  }
}
