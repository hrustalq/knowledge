import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssistantAskSource,
  AssistantMessageInfo,
  AssistantMessageRole,
  AssistantPrompt,
  AssistantThreadSummary,
  AssistantToolCall,
  AssistantUiBlock,
  CreateAssistantThreadResponse,
  DeleteAssistantThreadResponse,
  GetAssistantThreadResponse,
  ListAssistantThreadsResponse,
  TruncateAssistantThreadResponse,
  UpdateAssistantThreadResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import type { AssistantMessage, AssistantThread } from '@prisma/client';
import { t } from '../i18n/t.js';

const DEFAULT_THREAD_PAGE = 50;
const MAX_THREAD_PAGE = 100;
/** Long enough to tell two chats apart in a 16rem rail, short enough not to wrap. */
const AUTO_TITLE_CHARS = 60;

/**
 * Persistence for the chat pane's multi-turn threads (docs/features/09
 * follow-up). Deliberately thin: no business logic beyond
 * shape-mapping — AssistantService owns the actual turn (tool harness,
 * provider call, event publishing).
 */
@Injectable()
export class AssistantThreadsService {
  constructor(private readonly prisma: PrismaService) {}

  async createThread(
    workspaceId: string,
    createdBy: string,
    opts: { documentId?: string; title?: string } = {},
  ): Promise<CreateAssistantThreadResponse> {
    const thread = await this.prisma.assistantThread.create({
      data: {
        workspaceId,
        documentId: opts.documentId ?? null,
        title: opts.title ?? null,
        createdBy,
      },
    });
    return { thread: this.toSummary(thread) };
  }

  /**
   * The rail's roster. Cursor pagination is keyset over `updatedAt` (the sort
   * key) rather than an offset, so a thread bumped to the top by a reply in
   * another tab cannot make a later page skip or repeat a row.
   */
  async listThreads(
    workspaceId: string,
    opts: { search?: string; limit?: number; cursor?: string } = {},
  ): Promise<ListAssistantThreadsResponse> {
    const take = Math.min(Math.max(opts.limit ?? DEFAULT_THREAD_PAGE, 1), MAX_THREAD_PAGE);
    const search = opts.search?.trim();
    const before = opts.cursor ? new Date(opts.cursor) : null;
    const rows = await this.prisma.assistantThread.findMany({
      where: {
        workspaceId,
        ...(before && !Number.isNaN(before.getTime()) ? { updatedAt: { lt: before } } : {}),
        // A chat is findable by what was said in it, not only by its title —
        // most threads never get renamed, so title-only search finds nothing.
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: 'insensitive' as const } },
                { messages: { some: { content: { contains: search, mode: 'insensitive' as const } } } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: take + 1,
    });
    const page = rows.slice(0, take);
    const nextCursor = rows.length > take ? (page.at(-1)?.updatedAt.toISOString() ?? null) : null;
    if (page.length === 0) return { threads: [], nextCursor: null };
    // Latest message per thread, for the history-list preview line.
    const latest = await this.prisma.assistantMessage.findMany({
      where: { threadId: { in: page.map((t) => t.id) } },
      orderBy: [{ threadId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['threadId'],
    });
    const previewByThread = new Map(latest.map((m) => [m.threadId, m.content]));
    return {
      threads: page.map((t) => this.toSummary(t, previewByThread.get(t.id))),
      nextCursor,
    };
  }

  async updateThread(
    threadId: string,
    patch: { title?: string | null; providerId?: string | null },
  ): Promise<UpdateAssistantThreadResponse> {
    const current = await this.getThreadOrThrow(threadId);
    // A pin from another tenant would route this workspace's turns — and its
    // tokens — through a provider its admins never configured.
    if (patch.providerId) {
      const provider = await this.prisma.aiProvider.findUnique({
        where: { id: patch.providerId },
        select: { workspaceId: true, enabled: true },
      });
      if (!provider || provider.workspaceId !== current.workspaceId || !provider.enabled) {
        throw new NotFoundException(t('error.ai.providerUnavailable', { id: patch.providerId }));
      }
    }
    const thread = await this.prisma.assistantThread.update({
      where: { id: threadId },
      data: {
        ...(patch.title !== undefined ? { title: patch.title?.trim() || null } : {}),
        ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
        // A rename is metadata, not activity: keep the roster ordered by when
        // the conversation last moved, not by when someone tidied its label.
        updatedAt: undefined,
      },
    });
    return { thread: this.toSummary(thread) };
  }

  /** Deletes the thread and its history. No FK cascade on the relation, so messages go first. */
  async deleteThread(threadId: string): Promise<DeleteAssistantThreadResponse> {
    await this.getThreadOrThrow(threadId);
    await this.prisma.$transaction([
      this.prisma.assistantMessage.deleteMany({ where: { threadId } }),
      this.prisma.assistantThread.delete({ where: { id: threadId } }),
    ]);
    return { ok: true };
  }

  /**
   * Rewinds a thread to a message: that message and every message after it are
   * deleted. One primitive behind both per-message controls in the chat — the
   * reset button and an edit's save — because both cut inclusively.
   *
   * Cuts on an id set read in order rather than on `createdAt >= pivot`:
   * `assistant_messages.created_at` is not unique, so two rows written in the
   * same millisecond would make a timestamp comparison ambiguous about which
   * side of the cut they fall on. A thread holds a conversation's worth of
   * rows, so reading their ids first costs nothing.
   */
  async truncateFrom(threadId: string, messageId: string): Promise<TruncateAssistantThreadResponse> {
    await this.getThreadOrThrow(threadId);
    const rows = await this.prisma.assistantMessage.findMany({
      where: { threadId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const at = rows.findIndex((r) => r.id === messageId);
    // Also the answer for a message id belonging to some other thread.
    if (at < 0) throw new NotFoundException(t('error.assistant.messageNotFound', { messageId, threadId }));
    const doomed = rows.slice(at).map((r) => r.id);

    const [, thread] = await this.prisma.$transaction([
      this.prisma.assistantMessage.deleteMany({ where: { id: { in: doomed } } }),
      // Truncating is not metadata the way a rename is: the conversation
      // itself changed, so the roster should re-sort around it.
      this.prisma.assistantThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } }),
    ]);

    const survivors = await this.prisma.assistantMessage.findMany({
      where: { threadId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      removed: doomed.length,
      thread: this.toSummary(thread, survivors.at(-1)?.content),
      messages: survivors.map((m) => this.toMessageInfo(m)),
    };
  }

  /**
   * Names an untitled thread after its opening message. Threads are created
   * before anything is said, so without this every row in the rail reads "New
   * chat" — and a list you cannot scan is not a history. A manual rename wins
   * forever: this only ever fills a null.
   */
  async autoTitle(threadId: string, firstMessage: string): Promise<void> {
    const condensed = firstMessage.replace(/\s+/g, ' ').trim();
    if (!condensed) return;
    const title =
      condensed.length <= AUTO_TITLE_CHARS
        ? condensed
        : `${condensed.slice(0, AUTO_TITLE_CHARS).replace(/\s+\S*$/, '')}…`;
    await this.prisma.assistantThread.updateMany({
      where: { id: threadId, title: null },
      data: { title },
    });
  }

  async getThread(threadId: string): Promise<GetAssistantThreadResponse> {
    const thread = await this.getThreadOrThrow(threadId);
    const messages = await this.prisma.assistantMessage.findMany({
      where: { threadId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { thread: this.toSummary(thread), messages: messages.map((m) => this.toMessageInfo(m)) };
  }

  async getThreadOrThrow(threadId: string): Promise<AssistantThread> {
    const thread = await this.prisma.assistantThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException(t('error.assistant.threadNotFound', { id: threadId }));
    return thread;
  }

  /** Prior turns for the provider call, oldest first, most recent last. */
  async recentHistory(threadId: string, limit = 16): Promise<AssistantMessageInfo[]> {
    const rows = await this.prisma.assistantMessage.findMany({
      where: { threadId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse().map((m) => this.toMessageInfo(m));
  }

  async appendMessage(
    threadId: string,
    role: AssistantMessageRole,
    content: string,
    opts: {
      toolCalls?: AssistantToolCall[];
      sources?: AssistantAskSource[];
      uiBlocks?: AssistantUiBlock[];
      prompt?: AssistantPrompt | null;
    } = {},
  ): Promise<AssistantMessageInfo> {
    const [message] = await this.prisma.$transaction([
      this.prisma.assistantMessage.create({
        data: {
          threadId,
          role,
          content,
          toolCalls: (opts.toolCalls ?? []) as object,
          sources: (opts.sources ?? []) as object,
          uiBlocks: (opts.uiBlocks ?? []) as object,
          // Prisma distinguishes a SQL NULL from a JSON `null` literal; a turn
          // that asked nothing wants the column empty, not the string "null".
          prompt: opts.prompt ? (opts.prompt as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      }),
      this.prisma.assistantThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } }),
    ]);
    return this.toMessageInfo(message);
  }

  private toSummary(t: AssistantThread, lastMessagePreview?: string): AssistantThreadSummary {
    return {
      id: t.id,
      workspaceId: t.workspaceId,
      documentId: t.documentId,
      title: t.title,
      providerId: t.providerId,
      createdBy: t.createdBy,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      ...(lastMessagePreview !== undefined
        ? { lastMessagePreview: lastMessagePreview.slice(0, 140) }
        : {}),
    };
  }

  private toMessageInfo(m: AssistantMessage): AssistantMessageInfo {
    return {
      id: m.id,
      threadId: m.threadId,
      role: m.role as AssistantMessageRole,
      content: m.content,
      toolCalls: (m.toolCalls ?? []) as unknown as AssistantToolCall[],
      sources: (m.sources ?? []) as unknown as AssistantAskSource[],
      uiBlocks: (m.uiBlocks ?? []) as unknown as AssistantUiBlock[],
      prompt: (m.prompt ?? null) as unknown as AssistantPrompt | null,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
