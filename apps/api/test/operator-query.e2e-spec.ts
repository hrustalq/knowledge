import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';
import { GraphService, OPERATOR_QUERY_FUNCTIONS, OPERATOR_QUERY_METHODS, OPERATOR_QUERY_MOVES } from '../src/graph/graph.service.js';

/**
 * #788 against a real ArcadeDB, because a unit spec cannot prove what the store
 * dereferences: two workspaces, one secret, and every expression the fence
 * accepts. The control in the first test shows the bypass still leaks when it
 * skips the fence, so a pass here cannot mean the store simply had nothing to
 * give. Needs `make infra-up`, or ARCADE_URL/ARCADE_PASSWORD/ARCADE_DB. It adds
 * rows under two throwaway workspace ids and removes them.
 */

const SECRET = `SECRET-${randomUUID()}`;
const WS_A = randomUUID();
const WS_B = randomUUID();

const env: Record<string, string> = {
  ARCADE_URL: process.env.ARCADE_URL ?? 'http://localhost:2480',
  ARCADE_DB: process.env.ARCADE_DB ?? 'knowledge',
  ARCADE_USER: process.env.ARCADE_USER ?? 'root',
  ARCADE_PASSWORD: process.env.ARCADE_PASSWORD ?? 'playwithdata',
};

describe('operator query fence against a real store (e2e, #788)', () => {
  const arcade = new ArcadeClient({ get: (key: string) => env[key] } as never);
  const graph = new GraphService(arcade, {} as EntityAliasService);
  let secretRid = '';
  /** The string `#n:m` with no `#` in the query, as the bypass builds it. */
  const asRid = () => `(@rid.asString().left(1) + '${secretRid.slice(1)}')`;

  const run = (query: string) => graph.operatorQuery(WS_A, query, 50);
  let answered = 0;
  /**
   * The store refusing is fine; a row with the secret is the failure. So is the
   * fence refusing, which would mean the query never reached the store.
   */
  const leaked = async (query: string) => {
    try {
      const { rows } = await run(query);
      answered++;
      return JSON.stringify(rows).includes(SECRET);
    } catch (e) {
      if (e instanceof BadRequestException && e.message.includes('queryFailed')) return false;
      throw e;
    }
  };

  beforeAll(async () => {
    for (const ws of [WS_A, WS_B]) {
      const text = ws === WS_A ? 'ours' : SECRET;
      await arcade.command('sql', 'CREATE VERTEX Chunk SET workspaceId = :ws, chunkId = :id, text = :text', { ws, id: randomUUID(), text });
      await arcade.command('sql', 'CREATE VERTEX Entity SET workspaceId = :ws, entityKey = :key, name = :text', { ws, key: `op:${ws}`, text });
      await arcade.command('sql', 'CREATE VERTEX Document SET workspaceId = :ws, documentId = :id, title = :text', { ws, id: randomUUID(), text });
      await arcade.command(
        'sql',
        'CREATE EDGE DESCRIBES FROM (SELECT FROM Document WHERE workspaceId = :ws) TO (SELECT FROM Entity WHERE workspaceId = :ws) SET workspaceId = :ws, live = true',
        { ws },
      );
    }
    const [row] = await arcade.query<{ '@rid': string }>('sql', 'SELECT @rid FROM Chunk WHERE workspaceId = :ws', { ws: WS_B });
    secretRid = row['@rid'];
  });

  afterAll(async () => {
    for (const type of ['Chunk', 'Entity', 'Document']) {
      await arcade.command('sql', `DELETE VERTEX FROM ${type} WHERE workspaceId IN :ws`, { ws: [WS_A, WS_B] });
    }
  });

  it('the bypass forms are refused, though they still leak past the fence', async () => {
    for (const form of ['.asRecord().text', '.asRID().text', '.asRecord()']) {
      const query = `SELECT ${asRid()}${form} AS leak FROM Entity`;
      await expect(run(query)).rejects.toBeInstanceOf(BadRequestException);

      const scoped = query.replace('FROM Entity', 'FROM (SELECT FROM Entity WHERE workspaceId = :ws)');
      const raw = await arcade.query('sql', scoped, { ws: WS_A });
      expect(JSON.stringify(raw)).toContain(SECRET);
    }
  });

  it('no listed function reaches a record from an id built at query time', async () => {
    answered = 0;
    // `from` is listed for `FROM (`; called as a function it is the scan's to refuse.
    for (const name of [...OPERATOR_QUERY_FUNCTIONS].filter((f) => f !== 'from')) {
      for (const args of [asRid(), `@rid, ${asRid()}`, `${asRid()}, ${asRid()}`, `true, ${asRid()}, 1`]) {
        const query = `SELECT ${name}(${args}) AS a, ${name}(${args}).text AS b FROM Entity`;
        expect(await leaked(query), query).toBe(false);
        expect(await leaked(`SELECT expand(${name}(${args})) FROM Entity`), query).toBe(false);
      }
    }
    expect(answered).toBeGreaterThan(20);
  });

  it('no listed method reaches a record from an id built at query time', async () => {
    answered = 0;
    for (const name of [...OPERATOR_QUERY_METHODS, ...OPERATOR_QUERY_MOVES]) {
      for (const args of ['', asRid(), '1', `${asRid()}, ${asRid()}`]) {
        const query = `SELECT ${asRid()}.${name}(${args}) AS a, ${asRid()}.${name}(${args}).text AS b FROM Entity`;
        expect(await leaked(query), query).toBe(false);
      }
    }
    expect(answered).toBeGreaterThan(20);
  });

  it('the moves stay inside the workspace', async () => {
    for (const query of [
      "SELECT expand(out('DESCRIBES')) FROM Document",
      "SELECT in('DESCRIBES').title AS pages FROM Entity",
      'SELECT FROM (TRAVERSE out(), in() FROM Document)',
      'SELECT outV().title AS a, inV().name AS b FROM DESCRIBES',
    ]) {
      expect(await leaked(query), query).toBe(false);
    }
  });

  it('the #589 forms still answer, and only for this workspace', async () => {
    const count = await run('SELECT count(*) AS n FROM Entity');
    expect(count.rows).toEqual([{ n: 1 }]);

    const grouped = await run('SELECT name, count(*) AS n FROM (SELECT @type AS name FROM Entity) GROUP BY name');
    expect(grouped.rows).toEqual([{ name: 'Entity', n: 1 }]);

    const lowered = await run("SELECT text FROM Chunk WHERE (text).toLowerCase() LIKE '%our%'");
    expect(lowered.rows).toEqual([{ text: 'ours' }]);

    expect((await run('SELECT name.toLowerCase() AS low FROM Entity')).rows).toEqual([{ low: 'ours' }]);
    expect((await run('SELECT distinct(name) AS d FROM Entity')).rows).toEqual([{ d: 'ours' }]);

    const walked = await run("SELECT in('DESCRIBES').title AS pages FROM Entity");
    expect(walked.rows).toEqual([{ pages: ['ours'] }]);
  });
});
