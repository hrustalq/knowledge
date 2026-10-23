import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import { AgentExecutor } from '../src/agents/agent.executor.js';
import type { ResolvedAgent } from '../src/agents/agent-registry.service.js';
import type { Principal } from '../src/auth/principal.js';
import type { StoredCommunity } from '../src/graph/graph.service.js';

/**
 * The atlas over a community tree (#475, phase 2): level 0 summarised from
 * pages, the levels above from their children's summaries, one
 * COMMUNITY_MAX_PER_RUN budget finest first, and no stored community pointing
 * at a parent that was not written.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const principal = { userId: 'u-owner', workspaceRoles: {}, platformAdmin: false } as unknown as Principal;
const agent = {
  key: 'atlas',
  name: 'Atlas',
  instructions: 'chart',
  skillIds: [],
  config: { enabled: true },
} as unknown as ResolvedAgent;
const run = { id: 'run-1', workspaceId: WS, agentKey: 'atlas', createdBy: 'u-owner', locale: 'en', input: null } as unknown as AgentRun;

/** Four triangles of pages; a–b and c–d are close neighbours, the two pairs barely touch. */
function edges() {
  const out: Array<{ type: string; documentId: string; targetKey: string; extractor: string; confidence: number }> = [];
  const name = (pages: string[], key: string, times: number) => {
    for (let i = 0; i < times; i++) for (const documentId of pages) out.push({ type: 'RELATED_TO', documentId, targetKey: `${key}:${i}`, extractor: 'explicit', confidence: 1 });
  };
  for (const t of ['a', 'b', 'c', 'd']) name([`${t}1`, `${t}2`, `${t}3`], `area-${t}`, 4);
  name(['a1', 'b1'], 'ab1', 3);
  name(['a2', 'b2'], 'ab2', 3);
  name(['c1', 'd1'], 'cd1', 3);
  name(['c2', 'd2'], 'cd2', 3);
  name(['b3', 'c3'], 'bc', 1);
  return out;
}

function world(budget: number) {
  const replaceCommunities = vi.fn(async (_ws: string, _c: Array<StoredCommunity & { embedding: number[] }>, _fp: string) => {});
  const graph = {
    getWorkspaceRelationGraph: vi.fn(async () => ({ edges: edges(), documents: {}, entities: {} })),
    communityFingerprint: vi.fn(async () => null),
    liveChunks: vi.fn(async () => []),
    replaceCommunities,
  };
  const prisma = {
    document: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, title: `Page ${id}` }))) },
    agentRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  let n = 0;
  const client = { chat: vi.fn(async () => JSON.stringify({ title: `Area ${++n}`, summary: `What area ${n} covers.` })) };
  const env: Record<string, unknown> = { COMMUNITY_SUMMARIES_ENABLED: true, COMMUNITY_MAX_PER_RUN: budget };
  const executor = new AgentExecutor(
    prisma as never,
    graph as never,
    {} as never,
    client as never,
    {} as never,
    { renderPrompt: () => '', forTurn: async () => [] } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dimension: 2, embed: vi.fn(async () => [1, 0]) } as never,
    { get: (key: string) => env[key] } as never,
    {
      scopeFor: async (_p: unknown, workspaceId: string) => ({ workspaceId, bypass: true }),
      audienceScope: async (scope: unknown) => scope,
      documentFilterFor: async () => ({ kind: 'all' }),
    } as never,
    { promptFor: async () => ({ prompt: '', learningIds: [] }), dismissedPrompt: async () => '' } as never,
  );
  const stored = () => replaceCommunities.mock.calls[0]![1];
  return { executor, client, replaceCommunities, stored };
}

describe('AgentExecutor.chart over a community tree (#475)', () => {
  it('writes two levels, every non-root under a written parent, upper levels from child summaries', async () => {
    const w = world(30);
    await w.executor.run(run, agent, principal, async () => {});
    const rows = w.stored();
    expect(rows.map((r) => [r.communityId, r.level, r.parentId])).toEqual([
      ['0:a1', 0, '1:a1'],
      ['0:b1', 0, '1:a1'],
      ['0:c1', 0, '1:c1'],
      ['0:d1', 0, '1:c1'],
      ['1:a1', 1, null],
      ['1:c1', 1, null],
    ]);
    expect(rows.find((r) => r.communityId === '1:a1')!.members).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
    // Level 1's prompt is its children's titles and summaries, wrapped untrusted, never page text.
    const upper = w.client.chat.mock.calls[4]![1] as Array<{ role: string; content: string }>;
    expect(upper[1]!.content).toContain('## Area 1');
    expect(upper[1]!.content).toContain('What area 1 covers.');
    expect(upper[1]!.content).not.toContain('Page a1');
    expect(w.replaceCommunities.mock.calls[0]![2]).not.toBe('');
  });

  it('spends one budget finest first; a parent it cannot afford leaves its children roots', async () => {
    const w = world(5);
    await w.executor.run(run, agent, principal, async () => {});
    expect(w.client.chat).toHaveBeenCalledTimes(5);
    const rows = w.stored();
    expect(rows.map((r) => [r.communityId, r.parentId])).toEqual([
      ['0:a1', '1:a1'],
      ['0:b1', '1:a1'],
      ['0:c1', null],
      ['0:d1', null],
      ['1:a1', null],
    ]);
  });
});
