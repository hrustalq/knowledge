import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
import type { CreateThreadDto, ThreadAnchorDto } from './dto/merge-requests.dto.js';

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
    const anchor = dto.anchor ? this.validateAnchor(dto.anchor) : null;

    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.mergeRequestThread.create({
        data: {
          mergeRequestId,
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

  async setResolved(
    mergeRequestId: string,
    threadId: string,
    resolved: boolean,
    actorId: string = AUTHOR_ID_STUB,
  ): Promise<{ thread: MergeRequestThread }> {
    const mr = await this.getOpenMrOrThrow(mergeRequestId);
    const thread = await this.getThreadOrThrow(mergeRequestId, threadId);

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

  /** DTO stays loose (no polymorphic nested validators) — the per-type shape is enforced here. */
  private validateAnchor(dto: ThreadAnchorDto): MergeRequestThreadAnchor {
    switch (dto.type) {
      case 'line':
        if (!dto.revisionId || dto.line === undefined) {
          throw new BadRequestException('Line anchors require revisionId and line');
        }
        return {
          type: 'line',
          revisionId: dto.revisionId,
          line: dto.line,
          ...(dto.excerpt ? { excerpt: dto.excerpt } : {}),
        };
      case 'section':
        if (!dto.heading) throw new BadRequestException('Section anchors require heading');
        return { type: 'section', heading: dto.heading };
      case 'entity':
        if (!dto.entityKey) throw new BadRequestException('Entity anchors require entityKey');
        return { type: 'entity', entityKey: dto.entityKey };
    }
  }

  private toThread(t: ThreadWithComments): MergeRequestThread {
    return {
      threadId: t.id,
      mergeRequestId: t.mergeRequestId,
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
