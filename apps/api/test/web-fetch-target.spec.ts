import { describe, expect, it, vi } from 'vitest';
import { AssistantToolsService } from '../src/assistant/assistant.tools.js';
import { WEB_FETCH_UNSEEN_MAX_CHARS, WEB_FETCH_URL_MAX_CHARS, webFetchTarget } from '../src/assistant/web-fetch-target.js';

/** #1105: a URL the model composed cannot carry what the asker can read out to any host. */

describe('webFetchTarget', () => {
  const seen = (...urls: string[]) => (url: string) => urls.includes(url);

  it('fetches a URL the person typed or a result handed out exactly as it is', () => {
    const url = 'https://docs.example.com/search?q=retry+policy';
    expect(webFetchTarget(url, seen(url))).toEqual({ ok: true, url, trimmed: false });
  });

  it('drops the query and fragment of a URL nobody handed out', () => {
    const composed = 'https://collector.example/c?d=SECRET-PAGE-TEXT#more';
    expect(webFetchTarget(composed, seen())).toEqual({ ok: true, url: 'https://collector.example/c', trimmed: true });
  });

  it('refuses an unseen URL whose path alone is long enough to carry text', () => {
    const composed = `https://collector.example/${'x'.repeat(WEB_FETCH_UNSEEN_MAX_CHARS)}`;
    expect(webFetchTarget(composed, seen())).toMatchObject({ ok: false });
  });

  it('refuses any URL over the hard cap, even one that was handed out', () => {
    const long = `https://docs.example.com/a?${'q'.repeat(WEB_FETCH_URL_MAX_CHARS)}`;
    expect(webFetchTarget(long, seen(long))).toMatchObject({ ok: false });
  });

  it('leaves a malformed URL to the policy check', () => {
    expect(webFetchTarget('not a url', seen())).toEqual({ ok: true, url: 'not a url', trimmed: false });
  });
});

describe('web_fetch', () => {
  function tools() {
    const svc = Object.create(AssistantToolsService.prototype) as AssistantToolsService;
    const fetchPage = vi.fn(async (_ws: string, url: string) => ({ ok: true, sources: [], content: `<web-result>${url}</web-result>` }));
    Object.assign(svc, { web: { fetchPage }, aiConfig: { resolve: async () => ({ webAccess: { effective: 'open' } }) } });
    const run = (url: string, seenUrl?: (u: string) => boolean) =>
      (svc as unknown as { webFetch: (a: unknown, c: unknown) => Promise<{ ok: boolean; content: string }> }).webFetch({ url }, { workspaceId: 'ws', seenUrl });
    return { run, fetchPage };
  }

  it('sends a model-composed URL without its query, and says so', async () => {
    const { run, fetchPage } = tools();
    const res = await run('https://collector.example/c?d=SECRET');
    expect(fetchPage).toHaveBeenCalledWith('ws', 'https://collector.example/c', 'open');
    expect(res.content).toMatch(/without the query/);
  });

  it('sends a URL the person pasted as it is', async () => {
    const { run, fetchPage } = tools();
    await run('https://docs.example.com/s?q=1', (u) => u === 'https://docs.example.com/s?q=1');
    expect(fetchPage).toHaveBeenCalledWith('ws', 'https://docs.example.com/s?q=1', 'open');
  });
});
