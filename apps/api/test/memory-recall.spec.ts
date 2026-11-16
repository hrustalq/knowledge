import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BUDGET_FETCH, MemoryRecallService, cutToTokens, fuseLegs } from '../src/memory/memory-recall.service.js';
import { OpenAICompatibleMemoryReranker, RERANKER_COOLDOWN_MS } from '../src/memory/memory-reranker.js';

const bank = { id: 'bank-1', workspaceId: 'ws-1', bankId: 'agent' } as never;
const unit = (id: string, text = id) => ({ id, text, factType: 'world', context: null, tags: [], metadata: {}, documentId: 'd', occurredStart: null, occurredEnd: null, mentionedAt: null, entities: [], evidence: [] });

describe('recall, the pure half (#986)', () => {
  it('keeps results best first while the estimate fits', () => {
    const rows = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].map((text) => ({ text }));
    expect(cutToTokens(rows, 25).map((r) => r.text[0])).toEqual(['a', 'b']);
    expect(cutToTokens(rows, 5)).toEqual([]);
    expect(cutToTokens(rows, 1000)).toHaveLength(3);
  });

  it('fuses four legs by rank, so a memory several legs found rises', () => {
    const hit = (chunkId: string, score = 1) => ({ chunkId, score });
    const fused = fuseLegs([hit('a', 0.9), hit('b', 0.8)], [hit('b', 3), hit('c', 2)], [hit('d', 2)], [hit('b', 1)], 10).map((h) => h.chunkId);
    expect(fused[0]).toBe('b');
    expect([...fused].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(fuseLegs([], [], [], [hit('t')], 10).map((h) => h.chunkId)).toEqual(['t']);
    expect(fuseLegs([], [], [], [], 10)).toEqual([]);
  });
});

describe('MemoryRecallService (#986)', () => {
  function service(opts: { vector?: string[]; keyword?: string[]; rows?: string[]; route?: boolean; answers?: Record<string, number | Error>; matching?: string[]; texts?: Record<string, string>; rerankerScores?: Record<string, number>; rerankerError?: Error; candidateCap?: number } = {}) {
    const raw = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('ts_rank')) return (opts.keyword ?? []).map((chunkId, i) => ({ chunkId, score: 1 - i * 0.1 }));
      return [];
    });
    const prisma = {
      $queryRaw: raw,
      memoryUnit: {
        findMany: vi.fn(async (args: { select?: unknown; where: { id?: { in: string[] } } }) =>
          args.select ? (opts.matching ?? []).map((id) => ({ id })) : (opts.rows ?? []).filter((id) => args.where.id!.in.includes(id)).map((id) => ({ ...unit(id), text: opts.texts?.[id] ?? id })),
        ),
      },
    };
    const graph = { nearestMemoryUnits: vi.fn(async () => (opts.vector ?? []).map((chunkId, i) => ({ chunkId, score: 0.9 - i * 0.1 }))) };
    const embeddings = { embed: vi.fn(async () => [1, 0]) };
    const decision = {
      routeFor: vi.fn(async () => (opts.route ? { config: {}, thresholds: {} } : null)),
      noul: vi.fn(async (_call: unknown, state: { memory: string }) => {
        const id = Object.keys(opts.answers ?? {}).find((k) => state.memory.includes(`\n${k}\n`))!;
        const answer = opts.answers![id]!;
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    };
    const reranker = opts.rerankerScores || opts.rerankerError ? {
      candidateCap: opts.candidateCap ?? 50,
      rerank: vi.fn(async (_query: string, documents: string[]) => {
        if (opts.rerankerError) throw opts.rerankerError;
        return documents.map((id) => opts.rerankerScores?.[id] ?? 0);
      }),
    } : null;
    return { svc: new MemoryRecallService(prisma as never, graph as never, embeddings as never, decision as never, reranker as never), prisma, graph, embeddings, decision, reranker };
  }
  const ids = (r: { results: Array<{ id: string }> }) => r.results.map((x) => x.id);

  it('serves only rows PG still holds, with the scores each leg computed', async () => {
    const { svc, prisma } = service({ vector: ['a', 'gone'], keyword: ['b', 'a'], rows: ['a', 'b'] });
    const res = await svc.recall(bank, { query: 'q', userId: 'u1' });
    expect(ids(res)).toEqual(['a', 'b']);
    expect(res.results[0]!.scores).toEqual({ final: expect.any(Number), semantic: 0.9, keyword: 0.9 });
    expect(res.results[1]!.scores).toEqual({ final: expect.any(Number), keyword: 1 });
    // The final read is held to the bank and its workspace.
    expect(prisma.memoryUnit.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws-1', bankId: 'bank-1' }) }));
  });

  it('decides a tag or type filter in PG first and hands every leg and the reranker only those ids', async () => {
    const some = service({ matching: ['a'], vector: ['a'], rows: ['a'], rerankerScores: { a: 1 } });
    await some.svc.recall(bank, { query: 'q', tags: ['user:a'], tagsMatch: 'any_strict', budget: 'low', userId: 'u1' });
    expect(some.graph.nearestMemoryUnits).toHaveBeenCalledWith('ws-1', 'bank-1', [1, 0], BUDGET_FETCH.low, ['a']);
    expect(some.reranker!.rerank).toHaveBeenCalledWith('q', ['a']);
    const none = service({ matching: [] });
    expect((await none.svc.recall(bank, { query: 'q', types: ['observation'], userId: 'u1' })).results).toEqual([]);
    expect(none.embeddings.embed).not.toHaveBeenCalled();
  });

  it('refuses a reranker floor, and answers an empty query with nothing', async () => {
    const { svc, embeddings } = service();
    await expect(svc.recall(bank, { query: 'q', minScores: { reranker: 0.5 }, userId: 'u1' })).rejects.toBeInstanceOf(BadRequestException);
    expect((await svc.recall(bank, { query: '   ', userId: 'u1' })).results).toEqual([]);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it('lets the cross-encoder replace an irrelevant RRF leader and applies both post-query floors inclusively', async () => {
    const ranked = service({ vector: ['a', 'b', 'c'], rows: ['a', 'b', 'c'], rerankerScores: { a: 0.1, b: 0.9, c: 0.8 } });
    const res = await ranked.svc.recall(bank, { query: 'q', userId: 'u1' });
    expect(ids(res)).toEqual(['b', 'c', 'a']);
    expect(res.results[0]!.scores).toMatchObject({ reranker: 0.9, final: 0.9 });

    const filtered = service({ vector: ['a', 'b'], rows: ['a', 'b'], rerankerScores: { a: 0.8, b: 0.79 } });
    expect(ids(await filtered.svc.recall(bank, { query: 'q', minScores: { reranker: 0.8 }, userId: 'u1' }))).toEqual(['a']);
    expect(ids(await filtered.svc.recall(bank, { query: 'q', minScores: { final: 0.8 }, userId: 'u1' }))).toEqual(['a']);
  });

  it('caps scoring without losing RRF overflow and spends the token budget after reranking', async () => {
    const capped = service({ vector: ['a', 'b', 'c'], rows: ['a', 'b', 'c'], candidateCap: 2, rerankerScores: { a: 0.1, b: 0.9, c: 1 } });
    const res = await capped.svc.recall(bank, { query: 'q', userId: 'u1' });
    expect(ids(res)).toEqual(['b', 'a', 'c']);
    expect(capped.reranker!.rerank).toHaveBeenCalledWith('q', ['a', 'b']);
    expect(res.results[2]!.scores!.reranker).toBeUndefined();
    expect(ids(await capped.svc.recall(bank, { query: 'q', minScores: { reranker: 0 }, userId: 'u1' }))).toEqual(['b', 'a']);
    // A final floor is a reranker-scale number once a reranker ran: the RRF-scored overflow cannot be read against it (#1166).
    expect(ids(await capped.svc.recall(bank, { query: 'q', minScores: { final: 0 }, userId: 'u1' }))).toEqual(['b', 'a']);

    const budgeted = service({ vector: ['a', 'b'], rows: ['a', 'b'], texts: { a: 'a'.repeat(40), b: 'b' }, rerankerScores: { a: 0.1, b: 0.9 } });
    expect(ids(await budgeted.svc.recall(bank, { query: 'q', maxTokens: 5, userId: 'u1' }))).toEqual(['b']);
  });

  it('falls back to RRF on reranker failure, but never claims unscored rows passed its floor', async () => {
    const failed = service({ vector: ['a', 'b'], rows: ['a', 'b'], rerankerError: new Error('provider timeout') });
    const res = await failed.svc.recall(bank, { query: 'q', userId: 'u1' });
    expect(ids(res)).toEqual(['a', 'b']);
    expect(res.results[0]!.scores!.reranker).toBeUndefined();
    expect(ids(await failed.svc.recall(bank, { query: 'q', minScores: { reranker: 0.5 }, userId: 'u1' }))).toEqual([]);
  });

  it('keeps decision-model pruning separate from cross-encoder scoring and keeps a memory whose question failed', async () => {
    const answers = { a: 0.9, b: 0.1, c: new Error('timeout') };
    const routed = service({ vector: ['a', 'b', 'c'], rows: ['a', 'b', 'c'], route: true, answers, rerankerScores: { a: 0.1, b: 0.9, c: 0.8 } });
    expect(ids(await routed.svc.recall(bank, { query: 'q', prune: true, userId: 'u1' }))).toEqual(['c', 'a']);
    expect(routed.reranker!.rerank).toHaveBeenCalledOnce();
    expect(routed.decision.noul).toHaveBeenCalledWith(expect.objectContaining({ operation: 'memory-recall', userId: 'u1' }), expect.objectContaining({ memory: expect.stringContaining('<memories') }), expect.anything());
    const unrouted = service({ vector: ['a', 'b'], rows: ['a', 'b'], answers });
    expect(ids(await unrouted.svc.recall(bank, { query: 'q', prune: true, userId: 'u1' }))).toEqual(['a', 'b']);
    expect(unrouted.decision.noul).not.toHaveBeenCalled();
    const unasked = service({ vector: ['a', 'b'], rows: ['a', 'b'], route: true, answers });
    await unasked.svc.recall(bank, { query: 'q', userId: 'u1' });
    expect(unasked.decision.routeFor).not.toHaveBeenCalled();
  });

  it('hands a model the memories wrapped untrusted', async () => {
    const { svc } = service({ vector: ['a'], rows: ['a'] });
    const { text, results } = await svc.recallForModel(bank, { query: 'q', userId: 'u1' }, 'recall');
    expect(text).toMatch(/^<memories tool="recall">[\s\S]*\[M1\] a[\s\S]*<\/memories>$/);
    expect(results).toHaveLength(1);
  });
});

describe('OpenAICompatibleMemoryReranker (#1158)', () => {
  it('bounds the request, sends credentials, and returns normalized scores in candidate order', async () => {
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ index: 1, relevance_score: 0 }, { index: 0, relevance_score: 2 }] }),
    }));
    vi.stubGlobal('fetch', request);
    try {
      const provider = new OpenAICompatibleMemoryReranker('http://reranker.test/v1/', 'cross-encoder', 'secret', 1000, 2);
      const scores = await provider.rerank('q'.repeat(5000), ['a'.repeat(13_000), 'b', 'not sent']);
      expect(scores).toEqual([1 / (1 + Math.exp(-2)), 0.5]);
      const [url, init] = request.mock.calls[0]! as unknown as [string, RequestInit];
      expect(url).toBe('http://reranker.test/v1/rerank');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer secret' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: 'cross-encoder', top_n: 2, documents: ['a'.repeat(12_000), 'b'] });
      expect(body.query).toHaveLength(4000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts a provider call at its configured timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('provider timeout')));
    })));
    try {
      const provider = new OpenAICompatibleMemoryReranker('http://reranker.test/v1', 'cross-encoder', '', 1, 1);
      await expect(provider.rerank('q', ['a'])).rejects.toThrow('provider timeout');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('takes an already-normalized score as it is, so a floor keeps its meaning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.12 }, { index: 1, relevance_score: 0.97 }] }) })));
    try {
      const provider = new OpenAICompatibleMemoryReranker('http://reranker.test/v1', 'rerank-v3', '', 1000, 2, 'normalized');
      expect(await provider.rerank('q', ['a', 'b'])).toEqual([0.12, 0.97]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('after a failure skips the endpoint for a cool-down, then tries it again', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }));
    vi.stubGlobal('fetch', request);
    try {
      const provider = new OpenAICompatibleMemoryReranker('http://reranker.test/v1', 'cross-encoder', '', 1000, 2);
      await expect(provider.rerank('q', ['a'])).rejects.toThrow('503');
      await expect(provider.rerank('q', ['a'])).rejects.toThrow('cooling down');
      expect(request).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(RERANKER_COOLDOWN_MS + 1);
      request.mockImplementation(async () => ({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0 }] }) }) as never);
      expect(await provider.rerank('q', ['a'])).toEqual([0.5]);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
