import { describe, expect, it, vi } from 'vitest';

/**
 * Source-backed pages (#674, phase 1): the `web` adapter and the failure state
 * a link keeps between syncs.
 *
 * Pinned:
 * 1. A markdown source reads as written, titled by its first heading, and
 *    keeps its ETag / Last-Modified as the link version.
 * 2. A later fetch is conditional on that version; a 304 reads as notModified.
 * 3. HTML goes through article extraction; any other type is refused.
 * 4. A credential is a bearer token, or a `Header-Name: value` header.
 * 5. 404/410 counts toward archiving (at 3: archive, flag dependents
 *    outdated, alert) and never toward a failed sync.
 * 6. A transient failure retries at 1, 5 and 25 minutes, `Retry-After` only
 *    lengthening one; exhausted retries are a failed sync, alerted once at 3.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { ConnectorNetworkError, ConnectorRequestError } = await import('../src/connectors/adapters/connector.types.js');
const { WebAdapter, UnsupportedSourceError, credentialHeaders } = await import('../src/connectors/adapters/web.adapter.js');
const { isTransient, retryAfterMs } = await import('../src/connectors/adapters/web-failures.js');
const { WebSourcesService } = await import('../src/connectors/web-sources.service.js');

const fetchMock = vi.mocked(safeFetch);
const URL_MD = 'https://docs.example.com/guide/getting-started.md';

function ctx(credential: string | null = null) {
  return {
    connectorId: 'c1',
    workspaceId: 'w1',
    config: { url: URL_MD },
    credential,
    onStage: async () => undefined,
    debug: () => undefined,
    allowPrivate: false,
    userId: 'u1',
    locale: 'en' as const,
  };
}

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValueOnce(new Response(status === 304 ? null : body, { status, headers }));
}

function sentHeaders(call = 0): Record<string, string> {
  return (fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;
}

describe('WebAdapter', () => {
  const adapter = new WebAdapter();

  it('reads markdown as written and keeps the validators', async () => {
    fetchMock.mockReset();
    respond(200, '# Getting started\n\nInstall it.', { 'content-type': 'text/plain', etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT' });
    const doc = await adapter.fetch(ctx(), { externalId: URL_MD, title: URL_MD, url: URL_MD });
    expect(doc.title).toBe('Getting started');
    expect(doc.markdown).toBe('# Getting started\n\nInstall it.');
    expect(JSON.parse(doc.ref.version!)).toEqual({ etag: '"v1"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' });
    expect(sentHeaders()['user-agent']).toMatch(/KnowledgePlatform/);
    expect(sentHeaders()['if-none-match']).toBeUndefined();
  });

  it('fetches conditionally and reads a 304 as not modified', async () => {
    fetchMock.mockReset();
    respond(304, '');
    const knownVersion = JSON.stringify({ etag: '"v1"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' });
    const doc = await adapter.fetch(ctx(), { externalId: URL_MD, title: 'Guide', url: URL_MD, knownVersion });
    expect(doc.notModified).toBe(true);
    expect(sentHeaders()['if-none-match']).toBe('"v1"');
    expect(sentHeaders()['if-modified-since']).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
  });

  it('extracts the article from HTML and refuses other types', async () => {
    fetchMock.mockReset();
    respond(
      200,
      '<html><head><title>Guide</title></head><body><nav>Menu</nav><article><h1>Guide</h1><p>' +
        'Install the tool and run it. '.repeat(20) +
        '</p></article></body></html>',
      { 'content-type': 'text/html; charset=utf-8' },
    );
    const doc = await adapter.fetch(ctx(), { externalId: 'https://docs.example.com/guide', title: 'x', url: 'https://docs.example.com/guide' });
    expect(doc.markdown).toContain('Install the tool');
    expect(doc.markdown).not.toContain('Menu');

    respond(200, '%PDF', { 'content-type': 'application/pdf' });
    await expect(adapter.fetch(ctx(), { externalId: URL_MD, title: 'x', url: 'https://docs.example.com/a.pdf' })).rejects.toBeInstanceOf(
      UnsupportedSourceError,
    );
  });

  it('sends a token as Bearer and a header line as that header', () => {
    expect(credentialHeaders('abc123')).toEqual({ authorization: 'Bearer abc123' });
    expect(credentialHeaders('X-Api-Key: s3cret')).toEqual({ 'x-api-key': 's3cret' });
    expect(credentialHeaders('Authorization: Basic dXNlcg==')).toEqual({ authorization: 'Basic dXNlcg==' });
    expect(credentialHeaders(null)).toEqual({});
  });

  it('tells transient failures from the rest', () => {
    expect(isTransient(new ConnectorRequestError(503, URL_MD, ''))).toBe(true);
    expect(isTransient(new ConnectorRequestError(429, URL_MD, '', '120'))).toBe(true);
    expect(isTransient(new ConnectorNetworkError(URL_MD, new Error('ENOTFOUND')))).toBe(true);
    expect(isTransient(new ConnectorRequestError(404, URL_MD, ''))).toBe(false);
    expect(isTransient(new UnsupportedSourceError('application/pdf'))).toBe(false);
    expect(retryAfterMs(new ConnectorRequestError(429, URL_MD, '', '120'))).toBe(120_000);
    expect(retryAfterMs(new ConnectorRequestError(429, URL_MD, '', new Date(Date.now() + 60_000).toUTCString()))).toBeGreaterThan(50_000);
  });
});

describe('WebSourcesService.fetchFailed', () => {
  function harness(link: Record<string, unknown>) {
    const state = { ...link };
    const calls = { archived: [] as string[], flagged: [] as string[], alerts: [] as string[] };
    const prisma = {
      connectorLink: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(state, data)),
      },
      document: { findUnique: vi.fn(async () => ({ title: 'Guide', archivedAt: null })) },
      pageLink: { findMany: vi.fn(async () => [{ sourceDocumentId: 'dep1' }, { sourceDocumentId: 'dep2' }]) },
    };
    const verification = {
      archive: vi.fn(async (id: string) => calls.archived.push(id)),
      flag: vi.fn(async (id: string) => calls.flagged.push(id)),
    };
    const notifications = {
      notify: vi.fn(async (input: { metadata: { alert: string } }) => {
        calls.alerts.push(input.metadata.alert);
        return [];
      }),
    };
    const events = { announce: vi.fn(async () => undefined) };
    const service = new WebSourcesService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      verification as never,
      notifications as never,
      events as never,
      {} as never,
    );
    const row = { id: 'c1', workspaceId: 'w1', createdBy: 'owner', config: { url: URL_MD } };
    const fail = (err: unknown) => service.fetchFailed(row as never, { id: 'l1', documentId: 'd1', ...state } as never, err);
    return { state, calls, fail };
  }
  const base = { failures: 0, goneCount: 0, retryAttempt: 0, retryAt: null };

  it('archives after three 404s and flags the pages that link to it', async () => {
    const { state, calls, fail } = harness(base);
    const gone = new ConnectorRequestError(404, URL_MD, '');
    expect(await fail(gone)).toBe(false);
    expect(await fail(gone)).toBe(false);
    expect(calls.archived).toEqual([]);
    expect(await fail(gone)).toBe(true);
    expect(calls.archived).toEqual(['d1']);
    expect(calls.flagged).toEqual(['dep1', 'dep2']);
    expect(calls.alerts).toEqual(['gone']);
    expect(state.failures).toBe(0);
  });

  it('retries a transient failure at 1, 5 and 25 minutes, then counts a failed sync', async () => {
    const { state, calls, fail } = harness(base);
    const down = new ConnectorRequestError(503, URL_MD, '');
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const before = Date.now();
      await fail(down);
      delays.push(Math.round(((state.retryAt as Date).getTime() - before) / 60_000));
    }
    expect(delays).toEqual([1, 5, 25]);
    await fail(down);
    expect(state).toMatchObject({ failures: 1, retryAttempt: 0, retryAt: null });
    expect(calls.alerts).toEqual([]);
  });

  it('lets Retry-After lengthen a retry, never shorten it', async () => {
    const { state, fail } = harness(base);
    await fail(new ConnectorRequestError(429, URL_MD, '', '600'));
    expect(Math.round(((state.retryAt as Date).getTime() - Date.now()) / 60_000)).toBe(10);
  });

  it('alerts once when the third sync in a row fails', async () => {
    const { calls, fail } = harness({ ...base, failures: 2 });
    await fail(new UnsupportedSourceError('application/pdf'));
    expect(calls.alerts).toEqual(['failing']);
  });
});
