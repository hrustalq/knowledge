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
