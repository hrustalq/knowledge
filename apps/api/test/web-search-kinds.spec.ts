import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebResearchService, webSearchKind } from '../src/assistant/web-research.service.js';

/**
 * `web_search` kinds (#978).
 *
 * Pinned:
 * 1. Anything that is not a kind is a general search.
 * 2. The kind reaches SearXNG as `categories`: without it only the `general`
 *    engines are asked and the rest of the roster never fires.
 */
describe('web_search kinds', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to general for anything that is not a kind', () => {
    expect(webSearchKind('code')).toBe('code');
    expect(webSearchKind('images')).toBe('general');
    expect(webSearchKind('toString')).toBe('general');
    expect(webSearchKind(undefined)).toBe('general');
  });

  it('asks SearXNG for the category of the kind', async () => {
    const fetchMock = vi.fn(async (_url: URL) => Response.json({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { get: (key: string) => (key === 'WEB_SEARCH_URL' ? 'http://searxng:8080' : 1000) };
    const service = new WebResearchService(config as never, {} as never);

    await service.search('ws', 'attention is all you need', 'open', 5, 'science');
    await service.search('ws', 'nestjs guards', 'open');

    expect(fetchMock.mock.calls.map(([url]) => url.searchParams.get('categories'))).toEqual(['science', 'general']);
  });
});
