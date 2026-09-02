import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssistantAskSource,
  AssistantMessageInfo,
  AssistantMessageRole,
  AssistantThreadSummary,
  AssistantToolCall,
  AssistantUiBlock,
  CreateAssistantThreadResponse,
  GetAssistantThreadResponse,
  ListAssistantThreadsResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AssistantMessage, AssistantThread } from '@prisma/client';

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

  async listThreads(workspaceId: string): Promise<ListAssistantThreadsResponse> {
    const threads = await this.prisma.assistantThread.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    if (threads.length === 0) return { threads: [] };
    // Latest message per thread, for the history-list preview line.
    const latest = await this.prisma.assistantMessage.findMany({
      where: { threadId: { in: threads.map((t) => t.id) } },
      orderBy: [{ threadId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['threadId'],
    });
    const previewByThread = new Map(latest.map((m) => [m.threadId, m.content]));
    return {
      threads: threads.map((t) => this.toSummary(t, previewByThread.get(t.id))),
    };
  }

  async getThread(threadId: string): Promise<GetAssistantThreadResponse> {
    const thread = await this.getThreadOrThrow(threadId);
    const messages = await this.prisma.assistantMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
    });
    return { thread: this.toSummary(thread), messages: messages.map((m) => this.toMessageInfo(m)) };
  }

  async getThreadOrThrow(threadId: string): Promise<AssistantThread> {
    const thread = await this.prisma.assistantThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException(`Assistant thread ${threadId} not found`);
    return thread;
  }

  /** Prior turns for the provider call, oldest first, most recent last. */
  async recentHistory(threadId: string, limit = 16): Promise<AssistantMessageInfo[]> {
    const rows = await this.prisma.assistantMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.reverse().map((m) => this.toMessageInfo(m));
  }

  async appendMessage(
    threadId: string,
    role: AssistantMessageRole,
    content: string,
    opts: { toolCalls?: AssistantToolCall[]; sources?: AssistantAskSource[]; uiBlocks?: AssistantUiBlock[] } = {},
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
      createdAt: m.createdAt.toISOString(),
    };
  }
}
