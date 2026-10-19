import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { candidatePairs, conflictFingerprint, quoteIn, readJudgement, SHARED_ENTITY_SLACK, type CandidateChunk } from '../src/agents/contradiction.js';
import { ConflictsService } from '../src/conflicts/conflicts.service.js';
import { systemScope } from '../src/permissions/access-scope.js';

/** #81 phase 5 — the arbiter's deterministic half and the conflict rows it writes. */

const chunk = (documentId: string, i: number, embedding: number[], text = `${documentId} passage ${i}`): CandidateChunk => ({
  chunkId: `${documentId}-rev:${i}`,
  documentId,
  text,
  embedding,
});

describe('candidatePairs', () => {
  const chunks = [
    chunk('a', 0, [1, 0, 0]),
    chunk('a', 1, [0.99, 0.14, 0]),
    chunk('b', 0, [0.98, 0.2, 0]),
    chunk('c', 0, [0, 1, 0]),
    // 0.78–0.8 from a and b: under the 0.85 floor, inside the shared-entity slack.
    chunk('d', 0, [0.8, 0, 0.6]),
  ];
  const opts = { minSimilarity: 0.85, cap: 10 };

  it('pairs passages from different pages only, the closest pair per page pair', () => {
    const pairs = candidatePairs(chunks, null, opts)
    expect(pairs.map((p) => [p.a.documentId, p.b.documentId].sort().join('-'))).toEqual(['a-b'])
    expect(pairs[0]!.a.documentId).not.toBe(pairs[0]!.b.documentId)
  })

  it('needs at least one side in scope', () => {
    expect(candidatePairs(chunks, new Set(['c']), opts)).toEqual([])
    expect(candidatePairs(chunks, new Set(['b']), opts)).toHaveLength(1)
  })

  it('gives pages that share an entity the slack below the floor', () => {
    expect(SHARED_ENTITY_SLACK).toBeGreaterThan(0)
    const shares = (x: string, y: string) => [x, y].sort().join() === 'a,d'
    const pairs = candidatePairs(chunks, null, { ...opts, sharesEntity: shares })
    expect(pairs.map((p) => [p.a.documentId, p.b.documentId].sort().join('-')).sort()).toEqual(['a-b', 'a-d'])
  })

  it('caps the pairs, closest first', () => {
    const many = Array.from({ length: 6 }, (_, i) => chunk(`p${i}`, 0, [1, i * 0.01, 0]))
    const pairs = candidatePairs(many, null, { minSimilarity: 0.5, cap: 3 })
    expect(pairs).toHaveLength(3)
    expect(pairs[0]!.similarity).toBeGreaterThanOrEqual(pairs[2]!.similarity)
  })
})

describe('readJudgement', () => {
  const pair = {
    a: chunk('a', 0, [1], 'Payments retry failed webhooks up to 5 times.\nThen they give up.'),
    b: chunk('b', 0, [1], 'Failed webhooks are retried 3 times before the event is dropped.'),
    similarity: 0.9,
  }
  const good = {
    contradicts: true,
    aQuote: 'retry failed   webhooks up to 5 times',
    bQuote: 'Failed webhooks are retried 3 times',
    explanation: 'The retry count differs: 5 against 3.',
    confidence: 0.9,
  }

  it('keeps a confident contradiction whose quotes are in their passages', () => {
    expect(readJudgement(good, pair, 0.7)).toMatchObject({ contradicts: true, confidence: 0.9 })
  })

  it('drops a quote that is not in its passage — the model does not get to invent one', () => {
    expect(readJudgement({ ...good, bQuote: 'retried 4 times' }, pair, 0.7)).toBeNull()
    expect(readJudgement({ ...good, aQuote: 'b' }, pair, 0.7)).toBeNull()
  })

  it('drops "no", low confidence, and malformed answers', () => {
    expect(readJudgement({ ...good, contradicts: false }, pair, 0.7)).toBeNull()
    expect(readJudgement({ ...good, confidence: 0.5 }, pair, 0.7)).toBeNull()
    expect(readJudgement({ ...good, confidence: 7 }, pair, 0.7)).toBeNull()
    expect(readJudgement({ ...good, explanation: ' ' }, pair, 0.7)).toBeNull()
    expect(readJudgement(null, pair, 0.7)).toBeNull()
  })

  it('folds whitespace and case when checking a quote', () => {
    expect(quoteIn('Line one\n  line   two', 'LINE ONE line two')).toBe(true)
  })
})

describe('conflictFingerprint', () => {
  it('is the same whichever side comes first and however the quote is wrapped', () => {
    const x = conflictFingerprint([{ documentId: 'a', quote: 'Retries: 5' }, { documentId: 'b', quote: 'Retries: 3' }])
    const y = conflictFingerprint([{ documentId: 'b', quote: 'retries:   3' }, { documentId: 'a', quote: 'Retries:\n5' }])
    expect(x).toBe(y)
  })

  it('differs when a quote differs', () => {
    const x = conflictFingerprint([{ documentId: 'a', quote: 'Retries: 5' }, { documentId: 'b', quote: 'Retries: 3' }])
    const z = conflictFingerprint([{ documentId: 'a', quote: 'Retries: 6' }, { documentId: 'b', quote: 'Retries: 3' }])
    expect(x).not.toBe(z)
  })
})

describe('ConflictsService', () => {
  const WS = '11111111-1111-4111-8111-111111111111'
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'c1', workspaceId: WS, kind: 'doc-doc', status: 'open', fingerprint: 'f',
    aDocumentId: 'da', aRevisionId: 'ra', aChunkId: 'ra:0', aQuote: 'x',
    bDocumentId: 'db', bRevisionId: 'rb', bChunkId: 'rb:0', bQuote: 'y',
    codeRef: null, explanation: 'e', confidence: 0.9, agentRunId: null, findingIndex: null, mergeRequestId: null,
    detectedAt: new Date(0), resolvedAt: null, resolvedBy: null, resolution: null, ...over,
  })

  function service(opts: { rows?: unknown[]; visibleDocs?: string[]; updated?: number; raw?: unknown[] }) {
    const prisma = {
      $queryRaw: vi.fn(async () => opts.raw ?? []),
      knowledgeConflict: {
        findMany: vi.fn(async () => opts.rows ?? []),
        findFirst: vi.fn(async () => (opts.rows ?? [])[0] ?? null),
        findUniqueOrThrow: vi.fn(async () => ({ id: 'c1', status: 'dismissed' })),
        updateMany: vi.fn(async () => ({ count: opts.updated ?? 1 })),
      },
      document: { findMany: vi.fn(async () => (opts.visibleDocs ?? ['da', 'db']).map((id) => ({ id, title: `T ${id}` }))) },
    }
    const events = { publish: vi.fn(async () => undefined) }
    return { svc: new ConflictsService(prisma as never, events as never), prisma, events }
  }

  it('hides a conflict when either page is hidden from the caller', async () => {
    const { svc } = service({ rows: [row()], visibleDocs: ['da'] })
    expect(await svc.list(systemScope(WS))).toEqual([])
    await expect(svc.get(systemScope(WS), 'c1')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('re-detecting a dismissed conflict changes nothing and reports nothing new', async () => {
    const { svc, prisma, events } = service({ raw: [] })
    const side = { documentId: 'da', revisionId: 'ra', chunkId: 'ra:0', quote: 'x' }
    const out = await svc.record({ workspaceId: WS, kind: 'doc-doc', a: side, b: { ...side, documentId: 'db' }, explanation: 'e', confidence: 1, agentRunId: null, findingIndex: null })
    expect(out).toEqual({ id: 'c1', status: 'dismissed', written: false })
    expect(events.publish).not.toHaveBeenCalled()
    // The upsert only ever reopens a superseded row.
    const sql = (prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?')
    expect(sql).toContain("WHERE knowledge_conflicts.status = 'superseded'")
    expect(sql).toContain('ON CONFLICT (workspace_id, fingerprint)')
  })

  it('closing guards on open: a second press is a 409', async () => {
    const { svc, prisma } = service({ rows: [row({ status: 'resolved' })], updated: 0 })
    await expect(svc.close(systemScope(WS), 'c1', 'dismissed', 'u')).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.knowledgeConflict.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', status: 'open' } }))
  })

  it('a new head supersedes only open conflicts quoting an older revision of that page', async () => {
    const { svc, prisma } = service({ updated: 2 })
    expect(await svc.supersedeStale(WS, 'da', 'ra2')).toBe(2)
    expect(prisma.knowledgeConflict.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: WS,
        status: 'open',
        OR: [
          { aDocumentId: 'da', aRevisionId: { not: 'ra2' } },
          { bDocumentId: 'da', bRevisionId: { not: 'ra2' } },
        ],
      },
      data: { status: 'superseded' },
    })
  })
})
