import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_OUTCOME_SETTLE_DAYS,
  AGENT_OUTCOMES,
  AGENT_OUTCOME_SOURCES,
  outcomeFor,
  type AgentOutcome,
  type AgentOutcomeSubject,
} from '@knowledge/contracts';
import { outcomeCaseSql, outcomeFilterSql } from '../src/ai/agent-outcomes.service.js';
import { AiUsageService } from '../src/ai/ai-usage.service.js';
import { withAgentRun } from '../src/ai/agent-run-context.js';
import { AnswerFeedbackService } from '../src/feedback/answer-feedback.service.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * The learning-loop ledger (#305, phase 1). The classifier is derived, never
 * stored, so its table is pinned here; its SQL twin is run against Postgres
 * over the same rows in agent-outcomes.e2e-spec.ts. Attribution is asserted
 * on the rows the services write.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const DAY = 86_400_000;
const old = new Date(NOW.getTime() - (AGENT_OUTCOME_SETTLE_DAYS + 1) * DAY);
const fresh = new Date(NOW.getTime() - DAY);
const WS = '11111111-1111-4111-8111-111111111111';

const finding = (over: Partial<Extract<AgentOutcomeSubject, { source: 'finding' }>> = {}): AgentOutcomeSubject => ({
  source: 'finding',
  dismissedAt: null,
  mergeRequestStatus: null,
  finishedAt: fresh,
  ...over,
});

describe('outcomeFor', () => {
  const table: Array<[string, AgentOutcomeSubject, AgentOutcome]> = [
    ['a fresh finding nobody touched', finding(), 'pending'],
    ['a finding left standing past the window', finding({ finishedAt: old }), 'accepted'],
    ['a dismissed finding', finding({ dismissedAt: '2026-10-19T00:00:00Z' }), 'dismissed'],
    ['a dismissal beats a merged proposal', finding({ dismissedAt: '2026-10-19T00:00:00Z', mergeRequestStatus: 'merged' }), 'dismissed'],
    ['a finding whose merge request merged', finding({ mergeRequestStatus: 'merged' }), 'accepted'],
    ['a finding whose merge request closed unmerged', finding({ mergeRequestStatus: 'closed', finishedAt: old }), 'dismissed'],
    ['an open merge request stays pending past the window', finding({ mergeRequestStatus: 'open', finishedAt: old }), 'pending'],
    ['a run with no finish time', finding({ finishedAt: null }), 'pending'],
    ['an empty dismissal is no dismissal', finding({ dismissedAt: '' , finishedAt: old }), 'accepted'],
    ['an upvote', { source: 'answer', rating: 'up' }, 'accepted'],
    ['a downvote', { source: 'answer', rating: 'down' }, 'downvoted'],
    ['an unrated signal', { source: 'answer', rating: null }, 'pending'],
  ];
  it.each(table)('%s', (_name, subject, expected) => {
    expect(outcomeFor(subject, NOW)).toBe(expected);
  });

  it('emits every value of the vocabulary, and nothing outside it', () => {
    const emitted = new Set(table.map(([, s]) => outcomeFor(s, NOW)));
    expect([...emitted].sort()).toEqual([...AGENT_OUTCOMES].sort());
  });
});

describe('outcomeCaseSql — the SQL inverse', () => {
  it('names every outcome a source can produce, in the precedence outcomeFor applies', () => {
    const findingSql = outcomeCaseSql('finding', NOW).sql;
    const order = ["'dismissed'", "mr.status = 'merged'", "mr.status = 'closed'", 'mr.status IS NOT NULL', 'r.finished_at <='];
    const at = order.map((s) => findingSql.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(findingSql).not.toContain("'downvoted'");
    expect(outcomeCaseSql('answer', NOW).sql).toContain("'downvoted'");
  });

  it('binds the settle cutoff and the outcome as values, never as SQL text', () => {
    for (const source of AGENT_OUTCOME_SOURCES) {
      for (const o of AGENT_OUTCOMES) {
        const q = outcomeFilterSql(source, o, NOW);
        expect(q.values).toContain(o);
        expect(q.sql).not.toContain(o === 'pending' ? '= pending' : `= ${o}`);
      }
    }
    expect(outcomeCaseSql('finding', NOW).values).toEqual([new Date(NOW.getTime() - AGENT_OUTCOME_SETTLE_DAYS * DAY)]);
  });
});

describe('AiUsageService.record attribution', () => {
  const config = { workspaceId: WS, provider: 'openai', model: 'm', providerId: null } as never;
  const tokens = { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false };
  function service() {
    const create = vi.fn(async () => ({}));
    const svc = new AiUsageService({ aiUsage: { create } } as never, { estimateCostMicros: () => null } as never);
    return { svc, create };
  }

  it('stamps the agent run it is called inside, even unawaited', async () => {
    const { svc, create } = service();
    await withAgentRun({ agentKey: 'reviewer', agentRunId: 'run-1' }, async () => {
      void svc.record({ config, userId: 'u', operation: 'agent', tokens, durationMs: 1, ok: true });
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect((create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({
      agentKey: 'reviewer',
      agentRunId: 'run-1',
    });
  });

  it('leaves a call outside a run unattributed', async () => {
    const { svc, create } = service();
    await svc.record({ config, userId: 'u', operation: 'chat', tokens, durationMs: 1, ok: true });
    expect((create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({
      agentKey: null,
      agentRunId: null,
    });
  });
});

describe('AnswerFeedback attribution', () => {
  const alice: Principal = { userId: 'u-alice', email: 'a@x.test', displayName: 'A', avatarUrl: null, mode: 'session', isAdmin: false, locale: 'en' };
  const env = { get: () => true };

  function prisma(usage: { providerId: string | null; model: string } | null) {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      aiUsage: { findFirst: vi.fn(async () => usage) },
      answerFeedback: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
          rows.push(create);
          return { id: 'f', createdAt: new Date(), ...create };
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return { id: 'f', createdAt: new Date(), ...data };
        }),
      },
      assistantMessage: {
        findUnique: vi.fn(async () => ({
          id: 'm',
          role: 'assistant',
          content: 'answer',
          threadId: 't',
          createdAt: NOW,
          sources: [],
          confidence: null,
          thread: { id: 't', workspaceId: WS },
        })),
        findFirst: vi.fn(async () => ({ content: 'q' })),
      },
    };
  }

  it("a chat vote carries the model of the thread's reply, looked up on the server", async () => {
    const p = prisma({ providerId: 'prov-1', model: 'model-a' });
    await new AnswerFeedbackService(p as never, env as never).vote('m', alice, { rating: 'up' });
    expect(p.rows[0]).toMatchObject({ providerId: 'prov-1', model: 'model-a' });
    expect(p.aiUsage.findFirst.mock.calls[0]).toMatchObject([{ where: { workspaceId: WS, threadId: 't' } }]);
  });

  it("an /ask vote carries the caller's latest ask model; none found is unattributed, not a failure", async () => {
    const p = prisma({ providerId: null, model: 'model-b' });
    await new AnswerFeedbackService(p as never, env as never).voteOnAsk({ workspaceId: WS, query: 'q', rating: 'down' }, alice);
    expect(p.rows[0]).toMatchObject({ providerId: null, model: 'model-b' });
    expect(p.aiUsage.findFirst.mock.calls[0]).toMatchObject([{ where: { userId: 'u-alice', operation: 'ask' } }]);

    const none = prisma(null);
    await new AnswerFeedbackService(none as never, env as never).voteOnAsk({ workspaceId: WS, query: 'q', rating: 'up' }, alice);
    expect(none.rows[0]).toMatchObject({ providerId: null, model: null });
  });

  it("an implicit signal carries the turn's own config", async () => {
    const p = prisma(null);
    new AnswerFeedbackService(p as never, env as never).recordSignal({
      workspaceId: WS,
      surface: 'assistant',
      query: 'q',
      answer: 'a',
      sources: [],
      confidence: { level: 'none', score: 0, reasons: [] },
      principal: alice,
      providerId: 'prov-2',
      model: 'model-c',
    });
    await vi.waitFor(() => expect(p.rows).toHaveLength(1));
    expect(p.rows[0]).toMatchObject({ providerId: 'prov-2', model: 'model-c' });
    expect(p.aiUsage.findFirst).not.toHaveBeenCalled();
  });
});
