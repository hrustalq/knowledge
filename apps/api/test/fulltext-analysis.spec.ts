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

describe('BM25 clause (#400)', () => {
  it('sends a Cyrillic query to the Russian field and anything else to the English one', () => {
    expect(bm25Clause('От какой ветки базироваться?')).toEqual({
      match: { 'text.ru': { query: 'От какой ветки базироваться?', minimum_should_match: '2<60%' } },
    });
    expect(bm25Clause('base branch')).toEqual({
      match: { 'text.en': { query: 'base branch', minimum_should_match: '2<60%' } },
    });
    // Latin tokens inside a Russian query stay on the Russian field.
    expect(Object.keys(bm25Clause('ветка от main').match)).toEqual(['text.ru']);
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
    expect(body(create).mappings.properties.text.fields).toEqual({
      ru: { type: 'text', analyzer: 'russian' },
      en: { type: 'text', analyzer: 'english' },
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('_update_by_query'))).toBe(false);
  });

  it('adds the fields to an older index and re-analyzes only the rows lacking them, once', async () => {
    const fetchMock = stubOpenSearch({ exists: true, missing: 3 });
    const os = new OpenSearchFulltextProvider('http://os:9200', 'chunks');
    await os.search(WS, 'q', 10, UNFILTERED);
    await os.search(WS, 'q', 10, UNFILTERED);

    const mapping = fetchMock.mock.calls.find(([url, init]) => url === `${BASE}/_mapping` && init?.method === 'PUT') as Call | undefined;
    expect(body(mapping).properties.text.fields.ru).toEqual({ type: 'text', analyzer: 'russian' });
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
});
