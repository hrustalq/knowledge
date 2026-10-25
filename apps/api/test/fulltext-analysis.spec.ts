import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSearchFulltextProvider, bm25Clause } from '../src/fulltext/opensearch.provider.js';
import { UNFILTERED } from '../src/common/document-acl.js';

/**
 * #400: the BM25 leg matches on a language-analyzed field picked by the
 * query's script, under a minimum share of its terms, and an index created
 * before the analyzed fields gains and backfills them on first use.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const BASE = 'http://os:9200/chunks';

type Call = [string, RequestInit | undefined];

function stubOpenSearch(opts: { exists: boolean; missing: number }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === BASE && init?.method === 'PUT') {
      return opts.exists
        ? new Response('{"error":{"type":"resource_already_exists_exception"}}', { status: 400 })
        : new Response('{}', { status: 200 });
    }
    if (url === `${BASE}/_count`) return new Response(JSON.stringify({ count: opts.missing }));
    if (url.includes('_update_by_query')) return new Response('{"task":"n:1"}');
    return new Response(JSON.stringify({ hits: { hits: [] } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function body(call: Call | undefined) {
  return JSON.parse(String(call?.[1]?.body));
}

describe('BM25 clause (#400, #528)', () => {
  it('sends a Cyrillic query to the Russian fields and anything else to the English ones', () => {
    expect(bm25Clause('От какой ветки базироваться?')).toEqual({
      multi_match: {
        query: 'От какой ветки базироваться?',
        type: 'cross_fields',
        fields: ['text.ru', 'heading.ru^2'],
        minimum_should_match: '2<60%',
      },
    });
    expect(bm25Clause('base branch').multi_match.fields).toEqual(['text.en', 'heading.en^2']);
    // Latin tokens inside a Russian query stay on the Russian fields.
    expect(bm25Clause('ветка от main').multi_match.fields).toEqual(['text.ru', 'heading.ru^2']);
  });
});

describe('OpenSearch analyzed fields (#400)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('searches with the clause', async () => {
    const fetchMock = stubOpenSearch({ exists: false, missing: 0 });
    await new OpenSearchFulltextProvider('http://os:9200', 'chunks').search(WS, 'фичи', 10, UNFILTERED);
    const search = fetchMock.mock.calls.find(([url]) => url === `${BASE}/_search`) as Call | undefined;
    expect(body(search).query.bool.must).toEqual([bm25Clause('фичи')]);
  });

  it('creates a new index with the ru/en multi-fields and backfills nothing', async () => {
    const fetchMock = stubOpenSearch({ exists: false, missing: 0 });
    await new OpenSearchFulltextProvider('http://os:9200', 'chunks').search(WS, 'q', 10, UNFILTERED);
    const create = fetchMock.mock.calls.find(([url, init]) => url === BASE && init?.method === 'PUT') as Call | undefined;
    for (const field of ['text', 'heading']) {
      expect(body(create).mappings.properties[field].fields).toEqual({
        ru: { type: 'text', analyzer: 'russian' },
        en: { type: 'text', analyzer: 'english' },
      });
    }
    expect(fetchMock.mock.calls.some(([url]) => url.includes('_update_by_query'))).toBe(false);
  });

  it('adds the fields to an older index and re-analyzes only the rows lacking them, once', async () => {
    const fetchMock = stubOpenSearch({ exists: true, missing: 3 });
    const os = new OpenSearchFulltextProvider('http://os:9200', 'chunks');
    await os.search(WS, 'q', 10, UNFILTERED);
    await os.search(WS, 'q', 10, UNFILTERED);

    const mapping = fetchMock.mock.calls.find(([url, init]) => url === `${BASE}/_mapping` && init?.method === 'PUT') as Call | undefined;
    expect(body(mapping).properties.text.fields.ru).toEqual({ type: 'text', analyzer: 'russian' });
    expect(body(mapping).properties.heading.fields.ru).toEqual({ type: 'text', analyzer: 'russian' });
    const reanalyze = fetchMock.mock.calls.filter(([url]) => url.includes('_update_by_query'));
    expect(reanalyze).toHaveLength(1);
    expect(reanalyze[0][0]).toContain('wait_for_completion=false');
    // No script: the rows are rewritten from their own `_source`.
    expect(body(reanalyze[0] as Call)).toEqual({ query: { bool: { must_not: [{ exists: { field: 'text.ru' } }] } } });
  });

  it('does not re-analyze an index whose rows all have them', async () => {
    const fetchMock = stubOpenSearch({ exists: true, missing: 0 });
    await new OpenSearchFulltextProvider('http://os:9200', 'chunks').search(WS, 'q', 10, UNFILTERED);
    expect(fetchMock.mock.calls.some(([url]) => url.includes('_update_by_query'))).toBe(false);
  });

  it('writes the page title and the chunk headings into `heading`, once each (#528)', async () => {
    const fetchMock = stubOpenSearch({ exists: false, missing: 0 });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/_bulk?refresh=true') ? new Response('{"errors":false}') : new Response('{}'),
    );
    await new OpenSearchFulltextProvider('http://os:9200', 'chunks').indexRevisionChunks(
      WS,
      'r1',
      [
        { chunkId: 'r1:0', documentId: 'd1', revisionId: 'r1', index: 0, text: 'Accounts close monthly.', headingPath: [] },
        { chunkId: 'r1:1', documentId: 'd1', revisionId: 'r1', index: 1, text: 'Thirty days.', headingPath: ['Payroll ledger', 'Retention'] },
      ],
      { live: true, aclNodes: [], title: 'Payroll ledger' },
    );
    const bulk = fetchMock.mock.calls.find(([url]) => url.includes('_bulk')) as Call | undefined;
    const rows = String(bulk?.[1]?.body).trim().split('\n').filter((_, i) => i % 2 === 1).map((l) => JSON.parse(l));
    expect(rows.map((r) => r.heading)).toEqual([['Payroll ledger'], ['Payroll ledger', 'Retention']]);
    // The display path is untouched.
    expect(rows[1].headingPath).toEqual(['Payroll ledger', 'Retention']);
  });
});
