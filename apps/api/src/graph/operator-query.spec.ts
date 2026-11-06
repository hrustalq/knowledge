import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { ArcadeClient } from './arcade.client.js';
import type { EntityAliasService } from './entity-alias.service.js';
import { GraphService, scopeOperatorQuery } from './graph.service.js';

/**
 * The trusted-operator query's tenant fence (#589): every FROM is narrowed to
 * the workspace before the query reads, and anything that could read past
 * that narrowing is refused.
 */

const ENTITY = 'FROM (SELECT FROM Entity WHERE workspaceId = :workspaceId)';

describe('scopeOperatorQuery', () => {
  it.each([
    ['SELECT FROM Entity LIMIT 3', `SELECT ${ENTITY} LIMIT 3`],
    ['select count(*) from entity;', `select count(*) ${ENTITY}`],
    ['SELECT entityType, count(*) AS n FROM Entity GROUP BY entityType', `SELECT entityType, count(*) AS n ${ENTITY} GROUP BY entityType`],
    [
      'SELECT name, count(*) AS n FROM (SELECT @type AS name FROM Entity) GROUP BY name',
      `SELECT name, count(*) AS n FROM (SELECT @type AS name ${ENTITY}) GROUP BY name`,
    ],
    ["SELECT FROM Chunk WHERE text.toLowerCase() LIKE '%search%'", "SELECT FROM (SELECT FROM Chunk WHERE workspaceId = :workspaceId) WHERE text.toLowerCase() LIKE '%search%'"],
    ['SELECT FROM DESCRIBES WHERE live = true', 'SELECT FROM (SELECT FROM DESCRIBES WHERE workspaceId = :workspaceId) WHERE live = true'],
  ])('%s', (query, scoped) => {
    expect(scopeOperatorQuery(query)).toBe(scoped);
  });

  it.each([
    'SELECT FROM V LIMIT 2',
    'SELECT name FROM schema:types',
    'SELECT FROM HAS_CHUNK',
    'SELECT FROM Entity,Chunk',
    'SELECT FROM Entity:x',
    'SELECT FROM [Entity]',
    'SELECT FROM $parent',
    'SELECT FROM (SELECT FROM Entity)from(Chunk)',
    'SELECT FROM (Chunk)',
    "SELECT FROM Entity WHERE name = 'from x'",
  ])('refuses an unscoped target: %s', (query) => {
    expect(() => scopeOperatorQuery(query)).toThrow(/unscopedTarget/);
  });

  it.each([
    'SELECT FROM #12:3',
    'SELECT expand(#12:3)',
    'SELECT FROM/**/Chunk',
    'SELECT FROM Entity -- x',
    'SELECT FROM (MATCH {type: Chunk, as: c} RETURN c)',
    'SELECT FROM `Chunk`',
    "SELECT expand(vector.neighbors('Chunk[embedding]', [0.1], 5)) FROM Entity",
    "SELECT vectorNeighbors('Chunk[embedding]', [0.1], 5) AS n FROM Entity",
    "SELECT SEARCH_INDEX('Chunk[text]', 'x') FROM Entity",
    "SELECT eval('1') FROM Entity",
  ])('refuses syntax that could slip the scan: %s', (query) => {
    expect(() => scopeOperatorQuery(query)).toThrow(/unsupportedSyntax/);
  });

  const asRid = "(@rid.asString().left(1) + '1:1')";

  it.each([
    // The bypasses of #788: a record built from a string at query time.
    `SELECT ${asRid}.asRecord().text AS leak FROM Entity`,
    `SELECT ${asRid}.asRID().text AS leak FROM Entity`,
    `SELECT ${asRid}.asRecord() AS leak FROM Entity`,
    `SELECT '\\u00231:1'.asRecord().text AS leak FROM Entity`,
    // Spelled differently, to the scan.
    `SELECT ${asRid}.ASRECORD() FROM Entity`,
    `SELECT ${asRid} . asRecord  () FROM Entity`,
    `SELECT asRecord(${asRid}) FROM Entity`,
    // Graph functions that walk from a record id they are handed.
    `SELECT shortestPath(@rid, ${asRid}) FROM Entity`,
    `SELECT dijkstra(@rid, ${asRid}, 'w') FROM Entity`,
    // Off the list means refused: a reader a later ArcadeDB adds fails closed.
    'SELECT someNewReader(1) FROM Entity',
    'SELECT name.someNewReader() FROM Entity',
    'SELECT ts.first(name) FROM Entity',
    "SELECT promql('up') FROM Entity",
    // After a bare name the store looks for a dotted function first, so a move needs a computed receiver.
    "SELECT someNamespace.out('X') FROM Entity",
    "SELECT text.format('%s') FROM Entity",
    // A function is not a method, or the other way round.
    'SELECT name.count() FROM Entity',
    "SELECT toLowerCase('X') FROM Entity",
    // A paren after something that is neither a name nor an operator.
    "SELECT 'x'(1) FROM Entity",
    'SELECT (name)(1) FROM Entity',
    'SELECT name[0](1) FROM Entity',
    'SELECT name.(1) FROM Entity',
    'SELECT $fn(1) FROM Entity',
    // Strings are not parsed: this errs closed, and the 400 says so.
    "SELECT FROM Entity WHERE name = 'billing (prod)'",
  ])('refuses a call off the allowlist: %s', (query) => {
    expect(() => scopeOperatorQuery(query)).toThrow(/unsupportedSyntax/);
  });

  it.each([
    'SELECT coalesce(name, entityKey) AS label, (1 + 2) AS three FROM Entity',
    "SELECT out('DESCRIBES').title FROM Document",
    "SELECT in('DESCRIBES').title AS pages, name.toLowerCase().left(3) AS head FROM Entity",
    "SELECT expand(out('DESCRIBES')) FROM Document",
    "SELECT out('DESCRIBES').in('DESCRIBES').title AS peers FROM Document",
    'SELECT (text).toLowerCase() AS t, name.trim() AS n FROM Chunk',
    'SELECT FROM (TRAVERSE out() FROM Document) WHERE entityType IS NOT NULL',
    'SELECT FROM Entity WHERE a = 1 AND (b = 2 OR NOT (c = 3))',
    "SELECT FROM Entity WHERE entityKey IN (SELECT targetKey FROM DESCRIBES WHERE live = true)",
    "SELECT FROM Chunk WHERE text LIKE '%(v2)%'",
    "SELECT COUNT(*) AS n, MAX(idx) AS top FROM Chunk WHERE createdAt > date('2026-01-01')",
  ])('keeps what an operator needs: %s', (query) => {
    expect(scopeOperatorQuery(query)).toContain(':workspaceId');
  });

  it('refuses a query with no FROM', () => {
    expect(() => scopeOperatorQuery('SELECT 1')).toThrow(/noTarget/);
  });

  it('still refuses writes and second statements', () => {
    expect(() => scopeOperatorQuery('DELETE FROM Entity')).toThrow();
    expect(() => scopeOperatorQuery('SELECT FROM Entity; SELECT FROM Chunk')).toThrow();
    expect(() => scopeOperatorQuery('SELECT FROM (UPDATE Entity SET x = 1)')).toThrow();
  });
});

describe('GraphService.operatorQuery', () => {
  const graphWith = (query: ArcadeClient['query']) =>
    new GraphService({ query } as unknown as ArcadeClient, {} as EntityAliasService);

  it('runs the scoped query under a row cap and drops another tenant\'s row', async () => {
    let sent = '';
    const graph = graphWith((async (_lang: string, sql: string) => {
      sent = sql;
      return [{ n: 2 }, { workspaceId: 'ws-a', entityKey: 'op:a' }, { workspaceId: 'ws-b', entityKey: 'op:z' }];
    }) as ArcadeClient['query']);
    const out = await graph.operatorQuery('ws-a', 'SELECT count(*) AS n FROM Entity', 10);
    expect(sent).toBe(`SELECT FROM ( SELECT count(*) AS n ${ENTITY} ) LIMIT 11`);
    expect(out.rows).toEqual([{ n: 2 }, { workspaceId: 'ws-a', entityKey: 'op:a' }]);
  });

  it("drops a row holding another tenant's workspaceId at any depth, and keeps its own", async () => {
    const own = [{ page: { workspaceId: 'ws-a', title: 'ours' } }, { pages: [{ workspaceId: 'ws-a' }] }, { title: null, tags: ['x'] }];
    const foreign = [
      { leak: { workspaceId: 'ws-b', text: 'secret' } },
      { leak: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] },
      { a: { b: [{ c: { workspaceId: 'ws-b' } }] } },
    ];
    const graph = graphWith((async () => [...own, ...foreign]) as ArcadeClient['query']);
    const out = await graph.operatorQuery('ws-a', 'SELECT FROM Entity', 10);
    expect(out.rows).toEqual(own);
  });

  it("turns ArcadeDB's refusal into a 400 with its reason, and leaves an outage alone", async () => {
    const refused = graphWith(async () => {
      throw new Error('ArcadeDB query failed with 500: {"error":"x","detail":"SQL syntax error at line 1, column 21"}');
    });
    await expect(refused.operatorQuery('ws-a', 'SELECT FROM Entity', 10)).rejects.toBeInstanceOf(BadRequestException);
    const down = graphWith(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(down.operatorQuery('ws-a', 'SELECT FROM Entity', 10)).rejects.toBeInstanceOf(TypeError);
  });
});
