import { describe, expect, it, vi } from 'vitest';
import { GraphService } from '../src/graph/graph.service.js';
import { diffRevisionFacts, revisionStamps, stampWindow, type RevisionStamp } from '../src/graph/temporal.js';
import type { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';

/**
 * #81 phase 1 — valid time is stamped from PG revision times, and nothing a
 * page or a person stops asserting is deleted: it is closed or expired.
 */

const MAIN = 'branch-main';
const at = (iso: string) => new Date(iso);
const rev = (id: string, finalizedAt: string | null, branchId: string | null = MAIN) => ({
  id,
  branchId,
  finalizedAt: finalizedAt ? at(finalizedAt) : null,
});

describe('revisionStamps', () => {
  const revisions = [
    rev('r2', '2026-02-01T00:00:00Z'),
    rev('r1', '2026-01-01T00:00:00Z', null), // legacy: no branch id → default
    rev('draft', null),
    rev('feature', '2026-01-15T00:00:00Z', 'branch-x'),
    rev('r3', '2026-03-01T00:00:00Z'),
  ];

  it('chains default-branch revisions by finalized_at, the last one open', () => {
    const stamps = revisionStamps(revisions, MAIN);
    expect(stamps.filter((s) => s.lineage === 'default')).toEqual([
      { revisionId: 'r1', validFrom: at('2026-01-01T00:00:00Z').getTime(), validTo: at('2026-02-01T00:00:00Z').getTime(), lineage: 'default' },
      { revisionId: 'r2', validFrom: at('2026-02-01T00:00:00Z').getTime(), validTo: at('2026-03-01T00:00:00Z').getTime(), lineage: 'default' },
      { revisionId: 'r3', validFrom: at('2026-03-01T00:00:00Z').getTime(), validTo: null, lineage: 'default' },
    ]);
  });

  it('marks branch revisions as never valid and skips drafts', () => {
    const stamps = revisionStamps(revisions, MAIN);
    expect(stamps.find((s) => s.revisionId === 'feature')).toEqual({ revisionId: 'feature', validFrom: null, validTo: null, lineage: 'branch' });
    expect(stamps.some((s) => s.revisionId === 'draft')).toBe(false);
  });

  it('a window covers the revision and its default-branch neighbours only', () => {
    const stamps = revisionStamps(revisions, MAIN);
    expect(stampWindow(stamps, 'r2').map((s) => s.revisionId)).toEqual(['r1', 'r2', 'r3']);
    expect(stampWindow(stamps, 'r1').map((s) => s.revisionId)).toEqual(['r1', 'r2']);
    expect(stampWindow(stamps, 'feature').map((s) => s.revisionId)).toEqual(['feature']);
  });

  it('jobs finishing in any order converge on the same intervals', () => {
    const final = new Map(revisionStamps(revisions, MAIN).map((s) => [s.revisionId, s]));
    for (const order of [['r3', 'r1', 'r2'], ['r2', 'r3', 'r1'], ['r1', 'r2', 'r3']]) {
      const written = new Map<string, RevisionStamp>();
      const indexed: typeof revisions = [];
      for (const id of order) {
        indexed.push(revisions.find((r) => r.id === id)!);
        // Each job reads every finalized revision from PG, indexed or not.
        for (const s of stampWindow(revisionStamps(revisions, MAIN), id)) {
          if (indexed.some((r) => r.id === s.revisionId)) written.set(s.revisionId, s);
        }
      }
      for (const id of order) expect(written.get(id)).toEqual(final.get(id));
    }
  });
});

describe('diffRevisionFacts', () => {
  const fact = (type: string, key: string) => ({ type, target: { key } });
  it('keeps re-asserted facts, expires dropped ones, creates new ones, never revives expired rows', () => {
    const { keep, expire, create } = diffRevisionFacts(
      [
        { type: 'DEPENDS_ON', targetKey: 'service:a', expiredAt: null },
        { type: 'DEPENDS_ON', targetKey: 'service:b', expiredAt: null },
        { type: 'DEPENDS_ON', targetKey: 'service:c', expiredAt: 123 },
      ],
      [fact('DEPENDS_ON', 'service:a'), fact('DEPENDS_ON', 'service:c'), fact('OWNED_BY', 'team:x')],
    );
    expect(keep.map((f) => f.target.key)).toEqual(['service:a']);
    expect(expire.map((r) => r.targetKey)).toEqual(['service:b']);
    expect(create.map((f) => f.target.key)).toEqual(['service:c', 'team:x']);
  });
});

function graphWith(tables: Record<string, Array<Record<string, unknown>>>) {
  const commands: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const typeOf = (sql: string) => /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '';
  const arcade = {
    query: vi.fn(async (_lang: string, sql: string) => tables[typeOf(sql)] ?? []),
    command: vi.fn(async (_lang: string, sql: string, params?: Record<string, unknown>) => {
      commands.push({ sql, params });
      return [];
    }),
  };
  const aliases = { resolveAll: vi.fn(async (_ws: string, keys: string[]) => keys) };
  const graph = new GraphService(arcade as unknown as ArcadeClient, aliases as unknown as EntityAliasService);
  return { graph, commands };
}

const fact = (key: string) => ({
  type: 'DEPENDS_ON',
  target: { key, type: 'service', name: key },
  extractor: 'inferred' as const,
  confidence: 0.9,
});

describe('GraphService never deletes what a page or a person stops asserting (#81)', () => {
  it('a same-revision re-extraction expires the dropped fact and creates only the new one', async () => {
    const { graph, commands } = graphWith({
      DEPENDS_ON: [
        { targetKey: 'service:a', expiredAt: null },
        { targetKey: 'service:b' }, // written before #81: no expiredAt at all
      ],
      Entity: [],
    });
    await graph.replaceRevisionInferredFacts({
      workspaceId: 'ws',
      documentId: 'doc',
      revisionId: 'r1',
      title: 'Doc',
      facts: [fact('service:a'), fact('service:new')],
      live: true,
    });
    expect(commands.some((c) => /^DELETE/i.test(c.sql))).toBe(false);
    const expired = commands.filter((c) => /SET expiredAt = :now, retractedBy = 'extractor', live = false/.test(c.sql));
    expect(expired.map((c) => c.params?.targetKey)).toEqual(['service:b']);
    for (const c of expired) expect(c.params).toMatchObject({ workspaceId: 'ws', documentId: 'doc', revisionId: 'r1', extractor: 'inferred' });
    const created = commands.filter((c) => /^CREATE EDGE DEPENDS_ON/.test(c.sql));
    expect(created.map((c) => c.params?.key)).toEqual(['service:new']);
    expect(created[0].params).toMatchObject({ expiredAt: null, validFrom: null, lineage: null });
    expect(typeof created[0].params?.ingestedAt).toBe('number');
  });

  it('deleting a relation retracts it, attributed to the person', async () => {
    const { graph, commands } = graphWith({});
    await graph.deleteRelations('ws', 'doc', 'DEPENDS_ON', 'Service:A', undefined, 'user-1');
    expect(commands.some((c) => /^DELETE/i.test(c.sql))).toBe(false);
    const retract = commands.find((c) => /SET expiredAt = :now, retractedBy = :retractedBy, live = false/.test(c.sql));
    expect(retract?.params).toMatchObject({ workspaceId: 'ws', documentId: 'doc', targetKey: 'service:a', retractedBy: 'user:user-1' });
    // A document-level claim also stops being valid; a revision's own facts keep their PG-stamped interval.
    const close = commands.find((c) => /SET validTo = :now/.test(c.sql));
    expect(close?.sql).toContain("NOT (extractor IN ['frontmatter', 'inferred', 'spec'])");
  });

  it('a new document-level edge is valid from now; a revision-scoped one waits for its stamp', async () => {
    const { graph, commands } = graphWith({});
    await graph.addExplicitRelations({ workspaceId: 'ws', documentId: 'doc', revisionId: null, title: 'Doc', facts: [{ ...fact('service:a'), extractor: 'explicit' }] });
    const created = commands.find((c) => /^CREATE EDGE/.test(c.sql));
    expect(created?.params).toMatchObject({ lineage: 'default', validTo: null });
    expect(created?.params?.validFrom).toBe(created?.params?.ingestedAt);
  });

  it('the live projection never revives an expired row', async () => {
    const { graph, commands } = graphWith({});
    await graph.setLiveRevision('ws', 'doc', 'r2');
    const raises = commands.filter((c) => /^UPDATE (?!Chunk)\w+ SET live = true/.test(c.sql));
    expect(raises.length).toBeGreaterThan(0);
    for (const c of raises) expect(c.sql).toContain('expiredAt IS NULL');
  });

  it('stamps chunks and revision-scoped edges only, scoped to the page', async () => {
    const { graph, commands } = graphWith({});
    await graph.stampRevisions('ws', 'doc', [{ revisionId: 'r1', validFrom: 1, validTo: 2, lineage: 'default' }]);
    expect(commands[0].sql).toMatch(/^UPDATE Chunk SET validFrom = :validFrom, validTo = :validTo, lineage = :lineage WHERE workspaceId = :workspaceId AND documentId = :documentId AND revisionId = :revisionId$/);
    for (const c of commands.slice(1)) expect(c.sql).toContain("extractor IN ['frontmatter', 'inferred', 'spec']");
    for (const c of commands) expect(c.params).toMatchObject({ workspaceId: 'ws', documentId: 'doc', revisionId: 'r1', validFrom: 1, validTo: 2 });
  });

  it('getDocumentRelations hides expired rows unless asked', async () => {
    const { graph } = graphWith({
      DEPENDS_ON: [
        { targetKey: 'service:a', revisionId: null, extractor: 'explicit', confidence: 1 },
        { targetKey: 'service:b', revisionId: null, extractor: 'explicit', confidence: 1, expiredAt: 5, retractedBy: 'user:u' },
      ],
      Entity: [],
    });
    expect((await graph.getDocumentRelations('ws', 'doc')).map((r) => r.targetKey)).toEqual(['service:a']);
    const all = await graph.getDocumentRelations('ws', 'doc', { includeExpired: true });
    expect(all.find((r) => r.targetKey === 'service:b')?.temporal).toMatchObject({ expiredAt: 5, retractedBy: 'user:u' });
  });
});
