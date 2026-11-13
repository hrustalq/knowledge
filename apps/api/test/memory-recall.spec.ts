import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BUDGET_FETCH, MemoryRecallService, cutToTokens, fuseLegs } from '../src/memory/memory-recall.service.js';

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
  function service(opts: { vector?: string[]; keyword?: string[]; rows?: string[]; route?: boolean; answers?: Record<string, number | Error>; matching?: string[] } = {}) {
    const raw = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('ts_rank')) return (opts.keyword ?? []).map((chunkId, i) => ({ chunkId, score: 1 - i * 0.1 }));
      return [];
    });
    const prisma = {
      $queryRaw: raw,
      memoryUnit: {
        findMany: vi.fn(async (args: { select?: unknown; where: { id?: { in: string[] } } }) =>
          args.select ? (opts.matching ?? []).map((id) => ({ id })) : (opts.rows ?? []).filter((id) => args.where.id!.in.includes(id)).map((id) => unit(id)),
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
    return { svc: new MemoryRecallService(prisma as never, graph as never, embeddings as never, decision as never), prisma, graph, embeddings, decision };
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

  it('decides a tag or type filter in PG first and hands every leg its ids; nothing matching embeds nothing', async () => {
    const some = service({ matching: ['a'], vector: ['a'], rows: ['a'] });
    await some.svc.recall(bank, { query: 'q', tags: ['user:a'], tagsMatch: 'any_strict', budget: 'low', userId: 'u1' });
    expect(some.graph.nearestMemoryUnits).toHaveBeenCalledWith('ws-1', 'bank-1', [1, 0], BUDGET_FETCH.low, ['a']);
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

  it('prunes with the decision model only when one is routed, and keeps a memory whose question failed', async () => {
    const answers = { a: 0.9, b: 0.1, c: new Error('timeout') };
    const routed = service({ vector: ['a', 'b', 'c'], rows: ['a', 'b', 'c'], route: true, answers });
    expect(ids(await routed.svc.recall(bank, { query: 'q', prune: true, userId: 'u1' }))).toEqual(['a', 'c']);
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
