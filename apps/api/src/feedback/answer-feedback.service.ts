import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AnswerFeedback } from '@prisma/client';
import type {
  AnswerConfidence,
  AnswerFeedbackInfo,
  AnswerFeedbackReason,
  AnswerRating,
  AnswerSignalKind,
  AnswerSurface,
  AnswerVote,
  AssistantSource,
} from '@knowledge/contracts';
import { isWebSource } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';

const QUERY_MAX_CHARS = 4_000;
const EXCERPT_MAX_CHARS = 1_000;

/** What every vote carries, whichever surface it came from. */
interface VoteInput {
  rating: AnswerRating;
  reason?: AnswerFeedbackReason;
  comment?: string;
}

/** An implicit signal the harness noticed at the end of a turn. */
export interface AnswerSignalInput {
  workspaceId: string;
  surface: AnswerSurface;
  query: string;
  answer: string;
  sources: readonly AssistantSource[];
  confidence: AnswerConfidence | null;
  threadId?: string;
  messageId?: string;
  principal: Principal;
}

/**
 * Votes and implicit signals on answers (docs/features/38, issue #67 phase 2).
 *
 * One table, four surfaces. A vote from the chat pane keys on its message; a
 * vote on a one-shot `/ask` answer or over MCP has no message to key on, so
 * `/ask` stores every vote and MCP dedupes on the `traceId` the agent quotes
 * back from `knowledge_search`. Implicit signals (`low-confidence`,
 * `no-answer`) are written by the harness itself at the end of a weak turn,
 * fire-and-forget — a feedback write must never fail the answer it is about.
 *
 * Controller-free and loaded by both processes through `FeedbackCoreModule`:
 * phase 4's surveyor reads this table from the worker.
 */
@Injectable()
export class AnswerFeedbackService {
  private readonly logger = new Logger(AnswerFeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: ConfigService,
  ) {}

  /** `ANSWER_FEEDBACK_ENABLED` — a master switch, read per call so a test can flip it. */
  get enabled(): boolean {
    return this.env.get<boolean>('ANSWER_FEEDBACK_ENABLED') ?? true;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ForbiddenException(t('error.feedback.disabled'));
  }

  /**
   * Rate a persisted assistant reply. One vote per person per message: a
   * second vote replaces the first (the unique index is the upsert key).
   * `surface` is the client's word for which pane it voted from — the API
   * cannot tell the editor's pane from `/assistant` by the message row. The
   * REST route offers only the two panes; `chat` is set by the chat bot, whose
   * voter may be any member of the group the answer was posted in, not only
   * the person who asked (issue #71).
   */
  async vote(
    messageId: string,
    principal: Principal,
    input: VoteInput & { surface?: Extract<AnswerSurface, 'assistant' | 'editor-assistant' | 'chat'> },
  ): Promise<AnswerFeedbackInfo> {
    this.assertEnabled();
    const message = await this.prisma.assistantMessage.findUnique({
      where: { id: messageId },
      include: { thread: { select: { id: true, workspaceId: true } } },
    });
    if (!message) throw new NotFoundException(t('error.assistant.messageNotFoundById', { id: messageId }));
    if (message.role !== 'assistant') {
      throw new BadRequestException(t('error.feedback.messageNotAssistant', { id: messageId }));
    }
    // The question is the user turn before this reply. `created_at` is not
    // unique, so the tie-break is the same (createdAt, id) order the thread
    // itself is read in.
    const question = await this.prisma.assistantMessage.findFirst({
      where: {
        threadId: message.threadId,
        role: 'user',
        id: { not: message.id },
        createdAt: { lte: message.createdAt },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { content: true },
    });
    const sources = (message.sources ?? []) as unknown as AssistantSource[];
    const fields = {
      surface: input.surface ?? 'assistant',
      rating: input.rating,
      reason: input.reason ?? null,
      comment: input.comment?.trim() || null,
      query: (question?.content ?? '').slice(0, QUERY_MAX_CHARS),
      answerExcerpt: message.content.slice(0, EXCERPT_MAX_CHARS),
      citedDocumentIds: citedIds(sources) as object,
      confidence: message.confidence ?? Prisma.DbNull,
    };
    const row = await this.prisma.answerFeedback.upsert({
      where: { messageId_createdBy: { messageId, createdBy: principal.userId } },
      create: {
        workspaceId: message.thread.workspaceId,
        kind: 'vote',
        threadId: message.thread.id,
        messageId,
        createdBy: principal.userId,
        apiKeyId: principal.apiKey?.id ?? null,
        ...fields,
      },
      update: fields,
    });
    return toInfo(row);
  }

  /** Take a vote back. The end state is "no vote" either way, so a missing one is not an error. */
  async retract(messageId: string, principal: Principal): Promise<{ removed: boolean }> {
    this.assertEnabled();
    const res = await this.prisma.answerFeedback.deleteMany({
      where: { messageId, createdBy: principal.userId, kind: 'vote' },
    });
    return { removed: res.count > 0 };
  }

  /**
   * A vote on a one-shot `/ask` answer. Nothing was persisted to point at, so
   * the client sends what it saw; every call stores a row.
   */
  async voteOnAsk(
    input: VoteInput & {
      workspaceId: string;
      query: string;
      answerExcerpt?: string;
      citedDocumentIds?: string[];
    },
    principal: Principal,
  ): Promise<AnswerFeedbackInfo> {
    this.assertEnabled();
    const row = await this.prisma.answerFeedback.create({
      data: {
        workspaceId: input.workspaceId,
        kind: 'vote',
        surface: 'ask',
        rating: input.rating,
        reason: input.reason ?? null,
        comment: input.comment?.trim() || null,
        query: input.query.slice(0, QUERY_MAX_CHARS),
        answerExcerpt: input.answerExcerpt?.slice(0, EXCERPT_MAX_CHARS) ?? null,
        citedDocumentIds: (input.citedDocumentIds ?? []) as object,
        createdBy: principal.userId,
        apiKeyId: principal.apiKey?.id ?? null,
      },
    });
    return toInfo(row);
  }

  /**
   * `knowledge_feedback` over MCP. An agent that quotes the `traceId` of the
   * search it answered from gets one row per search, updated on a re-vote;
   * without one there is nothing to key on and every call is a new row.
   * `updateMany`-then-insert rather than a partial unique index (Prisma cannot
   * express one): a race writes a duplicate at worst, and the read side
   * tolerates that.
   */
  async voteOverMcp(
    input: VoteInput & { workspaceId: string; query: string; traceId?: string; documentIds?: string[] },
    principal: Principal,
  ): Promise<{ feedback: AnswerFeedbackInfo; deduplicated: boolean }> {
    this.assertEnabled();
    const fields = {
      rating: input.rating,
      reason: input.reason ?? null,
      comment: input.comment?.trim() || null,
      query: input.query.slice(0, QUERY_MAX_CHARS),
      citedDocumentIds: (input.documentIds ?? []) as object,
    };
    if (input.traceId) {
      const where = { traceId: input.traceId, createdBy: principal.userId, kind: 'vote', surface: 'mcp' };
      const updated = await this.prisma.answerFeedback.updateMany({ where, data: fields });
      if (updated.count > 0) {
        const row = await this.prisma.answerFeedback.findFirst({ where, orderBy: { createdAt: 'desc' } });
        if (row) return { feedback: toInfo(row), deduplicated: true };
      }
    }
    const row = await this.prisma.answerFeedback.create({
      data: {
        workspaceId: input.workspaceId,
        kind: 'vote',
        surface: 'mcp',
        traceId: input.traceId ?? null,
        createdBy: principal.userId,
        apiKeyId: principal.apiKey?.id ?? null,
        ...fields,
      },
    });
    return { feedback: toInfo(row), deduplicated: false };
  }

  /**
   * The harness's own verdict on a weak turn: `none` confidence is a
   * `no-answer`, `low` is a `low-confidence`, anything better writes nothing.
   * Fire-and-forget like `ActivityService.record` — a write here never throws
   * into the turn, and the message id makes it at most one row per turn.
   */
  recordSignal(input: AnswerSignalInput): void {
    const kind = signalKindFor(input.confidence);
    if (!kind || !this.enabled) return;
    void this.prisma.answerFeedback
      .create({
        data: {
          workspaceId: input.workspaceId,
          kind,
          surface: input.surface,
          query: input.query.slice(0, QUERY_MAX_CHARS),
          answerExcerpt: input.answer.slice(0, EXCERPT_MAX_CHARS) || null,
          threadId: input.threadId ?? null,
          messageId: input.messageId ?? null,
          citedDocumentIds: citedIds(input.sources) as object,
          confidence: (input.confidence as unknown as Prisma.InputJsonValue) ?? Prisma.DbNull,
          createdBy: input.principal.userId,
          apiKeyId: input.principal.apiKey?.id ?? null,
        },
      })
      .catch((e: unknown) => {
        this.logger.warn(`Answer signal not recorded (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  /** The caller's own votes on a set of messages, for a thread read. One query. */
  async ownVotes(messageIds: readonly string[], userId: string): Promise<Map<string, AnswerVote>> {
    const out = new Map<string, AnswerVote>();
    if (messageIds.length === 0) return out;
    const rows = await this.prisma.answerFeedback.findMany({
      where: { messageId: { in: [...messageIds] }, createdBy: userId, kind: 'vote' },
      select: { messageId: true, rating: true, reason: true, comment: true, createdAt: true },
    });
    for (const r of rows) {
      if (!r.messageId || !r.rating) continue;
      out.set(r.messageId, {
        rating: r.rating as AnswerRating,
        reason: (r.reason as AnswerFeedbackReason | null) ?? null,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return out;
  }
}

/** Pages only — a web citation has no id to report against. */
function citedIds(sources: readonly AssistantSource[]): string[] {
  return [...new Set(sources.filter((s) => !isWebSource(s)).map((s) => (s as { documentId: string }).documentId))];
}

export function signalKindFor(confidence: AnswerConfidence | null): Exclude<AnswerSignalKind, 'vote'> | null {
  if (!confidence) return null;
  if (confidence.level === 'none') return 'no-answer';
  if (confidence.level === 'low') return 'low-confidence';
  return null;
}

function toInfo(row: AnswerFeedback): AnswerFeedbackInfo {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as AnswerSignalKind,
    surface: row.surface as AnswerSurface,
    rating: (row.rating as AnswerRating | null) ?? null,
    reason: (row.reason as AnswerFeedbackReason | null) ?? null,
    comment: row.comment,
    query: row.query,
    messageId: row.messageId,
    threadId: row.threadId,
    traceId: row.traceId,
    citedDocumentIds: (row.citedDocumentIds ?? []) as unknown as string[],
    confidence: (row.confidence ?? null) as unknown as AnswerConfidence | null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
