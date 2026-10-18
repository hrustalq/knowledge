import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AnswerConfidence } from '@knowledge/contracts';
import { AnswerFeedbackService, signalKindFor } from '../src/feedback/answer-feedback.service.js';
import { AnswerVoteDto } from '../src/feedback/answer-feedback.dto.js';
import { AccessService } from '../src/auth/access.service.js';
import type { Principal } from '../src/auth/principal.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * Votes and implicit signals (docs/features/38, issue #67 phase 2): one vote
 * per person per message, the question recovered from the thread, MCP votes
 * deduped on the trace, and a signal write that can never fail the turn.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPLY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const QUESTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const alice: Principal = {
  userId: 'u-alice',
  email: 'a@x.test',
  displayName: 'Alice',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};
const readKey: Principal = { ...alice, mode: 'api-key', apiKey: { id: 'k-1', scope: 'read', workspaceId: WS } };

const confidence = (level: AnswerConfidence['level']): AnswerConfidence => ({ level, score: 0.5, reasons: [] });

function prismaWith(messages: Array<Record<string, unknown>>) {
  const store: Array<Record<string, unknown>> = [];
  const answerFeedback = {
    upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
      const row = { id: 'f-1', traceId: null, createdAt: new Date('2026-10-10T00:00:00Z'), ...create };
      store.push(row);
      return row;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `f-${store.length + 1}`,
        messageId: null,
        threadId: null,
        traceId: null,
        createdAt: new Date('2026-10-10T00:00:00Z'),
        ...data,
      };
      store.push(row);
      return row;
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
    findFirst: vi.fn(async () => null),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    findMany: vi.fn(async () => []),
  };
  const assistantMessage = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const m = messages.find((x) => x.id === where.id);
      return m ? { ...m, thread: { id: THREAD, workspaceId: WS } } : null;
    }),
    findFirst: vi.fn(async ({ where }: { where: { createdAt: { lte: Date }; id: { not: string } } }) =>
      messages
        .filter(
          (m) => m.role === 'user' && m.id !== where.id.not && (m.createdAt as Date) <= where.createdAt.lte,
        )
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .map((m) => ({ content: m.content }))[0] ?? null,
    ),
  };
  return { answerFeedback, assistantMessage, store };
}

const thread = [
  { id: QUESTION, threadId: THREAD, role: 'user', content: 'How long do sessions last?', createdAt: new Date('2026-10-01T00:00:00Z'), sources: [], confidence: null },
  {
    id: REPLY,
    threadId: THREAD,
    role: 'assistant',
    content: 'Sessions expire after one day [S1].',
    createdAt: new Date('2026-10-01T00:00:01Z'),
    sources: [
      { documentId: 'doc-a', title: 'Sessions', cite: 'S1' },
      { kind: 'web', url: 'https://x.test/', site: 'x.test', title: 'Web', cite: 'S2' },
    ],
    confidence: confidence('high'),
  },
];

function service(prisma: ReturnType<typeof prismaWith>, enabled = true) {
  const env = { get: (key: string) => (key === 'ANSWER_FEEDBACK_ENABLED' ? enabled : undefined) };
  return new AnswerFeedbackService(prisma as never, env as never);
}

describe('AnswerFeedbackService.vote', () => {
  it('upserts one vote per person per message, with the question and the cited pages', async () => {
    const prisma = prismaWith(thread);
    const info = await service(prisma).vote(REPLY, alice, { rating: 'down', reason: 'outdated', surface: 'editor-assistant' });

    expect(prisma.answerFeedback.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.answerFeedback.upsert.mock.calls[0]![0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.where).toEqual({ messageId_createdBy: { messageId: REPLY, createdBy: 'u-alice' } });
    expect(call.create).toMatchObject({
      workspaceId: WS,
      kind: 'vote',
      surface: 'editor-assistant',
      rating: 'down',
      reason: 'outdated',
      query: 'How long do sessions last?',
      answerExcerpt: 'Sessions expire after one day [S1].',
      // The web citation has no page to report against.
      citedDocumentIds: ['doc-a'],
      threadId: THREAD,
      messageId: REPLY,
      createdBy: 'u-alice',
      apiKeyId: null,
    });
    // A re-vote replaces the vote and nothing about who made it.
    expect(call.update).not.toHaveProperty('createdBy');
    expect(call.update).toMatchObject({ rating: 'down', reason: 'outdated' });
    expect(info).toMatchObject({ id: 'f-1', rating: 'down', reason: 'outdated', surface: 'editor-assistant', citedDocumentIds: ['doc-a'] });
  });

  it('defaults the surface to the assistant pane and records the API key that voted', async () => {
    const prisma = prismaWith(thread);
    await service(prisma).vote(REPLY, readKey, { rating: 'up' });
    const { create } = prisma.answerFeedback.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(create).toMatchObject({ surface: 'assistant', rating: 'up', reason: null, apiKeyId: 'k-1' });
  });

  it('rates only assistant replies', async () => {
    const prisma = prismaWith(thread);
    await expect(service(prisma).vote(QUESTION, alice, { rating: 'up' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service(prisma).vote('dddddddd-dddd-4ddd-8ddd-dddddddddddd', alice, { rating: 'up' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.answerFeedback.upsert).not.toHaveBeenCalled();
  });

  it('refuses everything when ANSWER_FEEDBACK_ENABLED=false', async () => {
    const prisma = prismaWith(thread);
    const svc = service(prisma, false);
    await expect(svc.vote(REPLY, alice, { rating: 'up' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.retract(REPLY, alice)).rejects.toBeInstanceOf(ForbiddenException);
    svc.recordSignal({ workspaceId: WS, surface: 'ask', query: 'q', answer: '', sources: [], confidence: confidence('none'), principal: alice });
    await new Promise((r) => setTimeout(r, 0));
    expect(prisma.answerFeedback.create).not.toHaveBeenCalled();
  });

  it('retracts only the caller\'s own vote', async () => {
    const prisma = prismaWith(thread);
    expect(await service(prisma).retract(REPLY, alice)).toEqual({ removed: true });
    expect(prisma.answerFeedback.deleteMany).toHaveBeenCalledWith({
      where: { messageId: REPLY, createdBy: 'u-alice', kind: 'vote' },
    });
  });
});

describe('AnswerFeedbackService over MCP and /ask', () => {
  it('dedupes an MCP re-vote on the trace it quotes, and inserts otherwise', async () => {
    const prisma = prismaWith(thread);
    const svc = service(prisma);
    const first = await svc.voteOverMcp({ workspaceId: WS, rating: 'up', query: 'q', traceId: 't-1' }, readKey);
    expect(first.deduplicated).toBe(false);
    expect(prisma.answerFeedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ surface: 'mcp', kind: 'vote', traceId: 't-1', apiKeyId: 'k-1', createdBy: 'u-alice' }),
    });

    prisma.answerFeedback.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.answerFeedback.findFirst.mockResolvedValueOnce({
      ...(prisma.store[0] as object),
      rating: 'down',
      reason: 'wrong',
    } as never);
    const again = await svc.voteOverMcp({ workspaceId: WS, rating: 'down', reason: 'wrong', query: 'q', traceId: 't-1' }, readKey);
    expect(again.deduplicated).toBe(true);
    expect(again.feedback).toMatchObject({ rating: 'down', reason: 'wrong', surface: 'mcp' });
    expect(prisma.answerFeedback.create).toHaveBeenCalledTimes(1);
  });

  it('stores every /ask vote as its own row with the surface pinned', async () => {
    const prisma = prismaWith(thread);
    const info = await service(prisma).voteOnAsk(
      { workspaceId: WS, rating: 'down', reason: 'no-answer', query: 'q', answerExcerpt: 'a', citedDocumentIds: ['doc-a'] },
      alice,
    );
    expect(info).toMatchObject({ surface: 'ask', rating: 'down', reason: 'no-answer', citedDocumentIds: ['doc-a'], messageId: null });
  });
});

describe('implicit signals', () => {
  it('maps confidence to a signal kind', () => {
    expect(signalKindFor(null)).toBeNull();
    expect(signalKindFor(confidence('high'))).toBeNull();
    expect(signalKindFor(confidence('medium'))).toBeNull();
    expect(signalKindFor(confidence('low'))).toBe('low-confidence');
    expect(signalKindFor(confidence('none'))).toBe('no-answer');
  });

  it('writes exactly one row for a weak turn, pointing at its message', async () => {
    const prisma = prismaWith(thread);
    service(prisma).recordSignal({
      workspaceId: WS,
      surface: 'editor-assistant',
      query: 'q',
      answer: 'I do not know.',
      sources: [],
      confidence: confidence('low'),
      threadId: THREAD,
      messageId: REPLY,
      principal: alice,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(prisma.answerFeedback.create).toHaveBeenCalledTimes(1);
    expect(prisma.answerFeedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'low-confidence',
        surface: 'editor-assistant',
        messageId: REPLY,
        threadId: THREAD,
        query: 'q',
        confidence: confidence('low'),
      }),
    });
  });

  it('never throws into the turn when the insert fails', async () => {
    const prisma = prismaWith(thread);
    prisma.answerFeedback.create.mockRejectedValueOnce(new Error('db down'));
    expect(() =>
      service(prisma).recordSignal({
        workspaceId: WS,
        surface: 'assistant',
        query: 'q',
        answer: '',
        sources: [],
        confidence: confidence('none'),
        principal: alice,
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(prisma.answerFeedback.create).toHaveBeenCalledTimes(1);
  });
});

describe('thread read', () => {
  it('returns the caller\'s own votes keyed by message, in one query', async () => {
    const prisma = prismaWith(thread);
    prisma.answerFeedback.findMany.mockResolvedValueOnce([
      { messageId: REPLY, rating: 'up', reason: null, comment: null, createdAt: new Date('2026-10-02T00:00:00Z') },
    ] as never);
    const votes = await service(prisma).ownVotes([REPLY, QUESTION], 'u-alice');
    expect(prisma.answerFeedback.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.answerFeedback.findMany.mock.calls[0]![0]).toMatchObject({
      where: { messageId: { in: [REPLY, QUESTION] }, createdBy: 'u-alice', kind: 'vote' },
    });
    expect(votes.get(REPLY)).toEqual({ rating: 'up', reason: null, comment: null, createdAt: '2026-10-02T00:00:00.000Z' });
    expect(votes.has(QUESTION)).toBe(false);
    expect(await service(prisma).ownVotes([], 'u-alice')).toEqual(new Map());
  });
});

describe('vote DTO', () => {
  it('requires a reason on a thumbs-down and accepts a bare thumbs-up', async () => {
    const down = await validate(plainToInstance(AnswerVoteDto, { rating: 'down' }));
    expect(down.map((e) => e.property)).toEqual(['reason']);
    const up = await validate(plainToInstance(AnswerVoteDto, { rating: 'up' }));
    expect(up).toEqual([]);
    const bad = await validate(plainToInstance(AnswerVoteDto, { rating: 'up', reason: 'because' }));
    expect(bad.map((e) => e.property)).toEqual(['reason']);
  });
});

describe('AccessService.workspaceOfAssistantMessage', () => {
  it('resolves the message through its thread and 404s an unknown id', async () => {
    const prisma = {
      assistantMessage: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === REPLY ? { thread: { workspaceId: WS } } : null,
        ),
      },
    };
    const access = new AccessService(prisma as never, noAuthPolicy);
    expect(await access.workspaceOfAssistantMessage(REPLY)).toBe(WS);
    await expect(access.workspaceOfAssistantMessage(QUESTION)).rejects.toBeInstanceOf(NotFoundException);
  });
});
