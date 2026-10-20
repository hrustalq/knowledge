import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { GraphService } from '../src/graph/graph.service.js';
import { asOfEdgeClause, factChangeDays, type TemporalPoint } from '../src/graph/temporal.js';
import { TemporalResolverService } from '../src/temporal/temporal-resolver.service.js';
import { ReleaseTagsService } from '../src/temporal/release-tags.service.js';
import { UNFILTERED } from '../src/common/document-acl.js';
import type { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';

/** #81 phase 2 — `asOf` resolution, the as-of predicate and the timeline counts. */

const WS = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';

function resolverWith(rows: { revision?: unknown; tag?: unknown }) {
  const prisma = {
    documentRevision: { findUnique: vi.fn(async () => rows.revision ?? null) },
    releaseTag: { findUnique: vi.fn(async () => rows.tag ?? null) },
  };
  return { resolver: new TemporalResolverService(prisma as never), prisma };
}

describe('TemporalResolverService', () => {
  it('no asOf and no knownAt is no point: the caller reads the live graph', async () => {
    expect(await resolverWith({}).resolver.resolve(WS)).toBeUndefined();
    expect(await resolverWith({}).resolver.resolve(WS, '  ', '')).toBeUndefined();
  });

  it('takes an ISO date as-is and echoes what applied', async () => {
    const p = await resolverWith({}).resolver.resolve(WS, '2026-05-01T00:00:00Z');
    expect(p).toEqual({
      at: Date.parse('2026-05-01T00:00:00Z'),
      knownAt: null,
      resolved: { kind: 'date', ref: '2026-05-01T00:00:00Z', at: '2026-05-01T00:00:00.000Z', knownAt: null },
    });
  });

  it('clamps a future date to now', async () => {
    const before = Date.now();
    const p = await resolverWith({}).resolver.resolve(WS, '2999-01-01');
    expect(p!.at).toBeGreaterThanOrEqual(before);
    expect(p!.at).toBeLessThanOrEqual(Date.now());
  });

  it('rejects a malformed value with 400', async () => {
    for (const bad of ['yesterday', '1', 'rev:not-a-uuid', '2026-13-45']) {
      await expect(resolverWith({}).resolver.resolve(WS, bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(resolverWith({}).resolver.resolve(WS, undefined, 'soon')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves rev:<uuid> to its finalize time', async () => {
    const finalizedAt = new Date('2026-03-01T10:00:00Z');
    const { resolver } = resolverWith({ revision: { finalizedAt, document: { workspaceId: WS } } });
    const p = await resolver.resolve(WS, `rev:${REV}`);
    expect(p).toMatchObject({ at: finalizedAt.getTime(), resolved: { kind: 'revision', ref: `rev:${REV}` } });
  });

  it("another workspace's revision is a 404, exactly like a missing one", async () => {
    const other = resolverWith({ revision: { finalizedAt: new Date(), document: { workspaceId: 'other' } } });
    await expect(other.resolver.resolve(WS, `rev:${REV}`)).rejects.toBeInstanceOf(NotFoundException);
    await expect(resolverWith({}).resolver.resolve(WS, `rev:${REV}`)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a draft revision has no point in time yet: 400', async () => {
    const { resolver } = resolverWith({ revision: { finalizedAt: null, document: { workspaceId: WS } } });
    await expect(resolver.resolve(WS, `rev:${REV}`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves tag:<name> in the caller workspace; an unknown tag is a 404', async () => {
    const tagAt = new Date('2026-02-02T00:00:00Z');
    const { resolver, prisma } = resolverWith({ tag: { at: tagAt } });
    expect(await resolver.resolve(WS, 'tag:v2.3')).toMatchObject({ at: tagAt.getTime(), resolved: { kind: 'tag', ref: 'tag:v2.3' } });
    expect(prisma.releaseTag.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId_name: { workspaceId: WS, name: 'v2.3' } } }));
    await expect(resolverWith({}).resolver.resolve(WS, 'tag:nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('knownAt alone reads now on the valid axis', async () => {
    const p = await resolverWith({}).resolver.resolve(WS, undefined, '2026-01-01T00:00:00Z');
    expect(p).toMatchObject({ knownAt: Date.parse('2026-01-01T00:00:00Z'), resolved: { kind: 'now', ref: 'now' } });
  });
});

const point = (at: number, knownAt: number | null = null): TemporalPoint => ({
  at,
  knownAt,
  resolved: { kind: 'date', ref: String(at), at: new Date(at).toISOString(), knownAt: null },
});

/**
 * Evaluate the as-of clause the way ArcadeDB would, over plain rows — the
 * predicate's meaning pinned without a database. Missing properties are null,
 * as ArcadeDB reads them.
 */
function admits(row: Record<string, unknown>, p: TemporalPoint): boolean {
  const { params } = asOfEdgeClause(p, '__scoped__');
  const v = (k: string) => (row[k] ?? null) as number | string | null;
  const scoped = ['frontmatter', 'inferred', 'spec'].includes(String(row.extractor));
  return (
    (v('validTo') === null || (v('validTo') as number) > params.asOfAt) &&
    ((v('lineage') === 'default' && (v('validFrom') as number) <= params.asOfAt) || (v('lineage') === null && v('validFrom') === null && !scoped)) &&
    (v('ingestedAt') === null || (v('ingestedAt') as number) <= params.asOfKnown) &&
    (v('expiredAt') === null || (v('expiredAt') as number) > params.asOfKnown)
  );
}

describe('the as-of predicate', () => {
  const v1 = { extractor: 'frontmatter', lineage: 'default', validFrom: 100, validTo: 200, ingestedAt: 101 };
  const v2 = { extractor: 'frontmatter', lineage: 'default', validFrom: 200, validTo: null, ingestedAt: 201 };

  it('a superseded fact is visible inside its interval and not after', () => {
    expect(admits(v1, point(150))).toBe(true);
    expect(admits(v1, point(200))).toBe(false); // half-open: the next revision owns its own instant
    expect(admits(v2, point(200))).toBe(true);
    expect(admits(v2, point(99))).toBe(false);
  });

  it('a branch revision is never valid', () => {
    expect(admits({ extractor: 'frontmatter', lineage: 'branch', validFrom: null, validTo: null }, point(150))).toBe(false);
  });

  it('knownAt sees a retraction only after it happened', () => {
    const retracted = { ...v2, expiredAt: 300, retractedBy: 'extractor' };
    expect(admits(retracted, point(250, 250))).toBe(true);
    expect(admits(retracted, point(250, 350))).toBe(false);
    expect(admits(v2, point(250, 150))).toBe(false); // not yet written at 150
  });

  it('pre-#81 document-level edges read as valid all along; unstamped revision rows do not', () => {
    expect(admits({ extractor: 'explicit' }, point(50))).toBe(true);
    expect(admits({ extractor: 'inferred' }, point(50))).toBe(false);
  });

  it('binds the instants as parameters, never into the text', () => {
    const { sql, params } = asOfEdgeClause(point(1234, 5678), "extractor IN ['frontmatter']");
    expect(sql).not.toContain('1234');
    expect(sql).not.toContain('5678');
    expect(params).toEqual({ asOfAt: 1234, asOfKnown: 5678 });
  });

  it('getWorkspaceRelationGraph swaps the live filter for the as-of clause and keeps only mentioned entities', async () => {
    const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const arcade = {
      query: vi.fn(async (_l: string, sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (/FROM DEPENDS_ON/.test(sql)) return [{ documentId: 'd', targetKey: 'service:a', extractor: 'frontmatter', confidence: 1 }];
        if (/FROM Entity/.test(sql)) return [{ entityKey: 'service:a', entityType: 'service', name: 'a' }, { entityKey: 'service:b', entityType: 'service', name: 'b' }];
        if (/FROM Document/.test(sql)) return [{ documentId: 'd', title: 'D' }];
        return [];
      }),
      command: vi.fn(),
    };
    const graph = new GraphService(arcade as unknown as ArcadeClient, {} as EntityAliasService);
    const g = await graph.getWorkspaceRelationGraph(WS, UNFILTERED, point(150, 160));
    const edgeQuery = queries.find((q) => /FROM DEPENDS_ON/.test(q.sql))!;
    expect(edgeQuery.sql).not.toContain('live IS NULL');
    expect(edgeQuery.sql).toContain('validFrom <= :asOfAt');
    expect(edgeQuery.params).toMatchObject({ workspaceId: WS, asOfAt: 150, asOfKnown: 160 });
    expect(Object.keys(g.entities)).toEqual(['service:a']);
  });
});

describe('factChangeDays', () => {
  const day = (d: string) => Date.parse(`${d}T12:00:00Z`);
  it('counts opens and closes per UTC day, cancelling a fact carried into the next revision', () => {
    const rows = [
      // service:a asserted by v1, carried into v2 (closes and reopens at the same instant), dropped by v3.
      { documentId: 'd', type: 'DEPENDS_ON', targetKey: 'service:a', validFrom: day('2026-01-01'), validTo: day('2026-01-05') },
      { documentId: 'd', type: 'DEPENDS_ON', targetKey: 'service:a', validFrom: day('2026-01-05'), validTo: day('2026-01-09') },
      // service:b appears with v3.
      { documentId: 'd', type: 'DEPENDS_ON', targetKey: 'service:b', validFrom: day('2026-01-09'), validTo: null },
    ];
    expect(factChangeDays(rows, day('2026-01-01') - 1, day('2026-02-01'))).toEqual([
      { day: '2026-01-01', opened: 1, closed: 0 },
      { day: '2026-01-09', opened: 1, closed: 1 },
    ]);
  });

  it('ignores changes outside the window', () => {
    const rows = [{ documentId: 'd', type: 'DEPENDS_ON', targetKey: 'x', validFrom: day('2025-12-01'), validTo: day('2026-01-02') }];
    expect(factChangeDays(rows, day('2026-01-01'), day('2026-01-03'))).toEqual([{ day: '2026-01-02', opened: 0, closed: 1 }]);
  });
});

describe('ReleaseTagsService', () => {
  it('a duplicate name is a 409 with the name in the flat extras', async () => {
    const prisma = {
      releaseTag: {
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        }),
      },
    };
    const service = new ReleaseTagsService(prisma as never, {} as never, {} as never);
    const err = await service.create({ workspaceId: WS, name: 'v1' }, 'u').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, reason: 'release-tag-duplicate', name: 'v1' });
  });

  it('a project from another workspace is refused', async () => {
    const prisma = { project: { findFirst: vi.fn(async () => null) }, releaseTag: { create: vi.fn() } };
    const service = new ReleaseTagsService(prisma as never, {} as never, {} as never);
    await expect(service.create({ workspaceId: WS, projectId: REV, name: 'v1' }, 'u')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.releaseTag.create).not.toHaveBeenCalled();
  });
});
