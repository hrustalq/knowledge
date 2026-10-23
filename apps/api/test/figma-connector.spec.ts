import { afterEach, describe, expect, it, vi } from 'vitest';
import { figmaTokenExpiry, parseFigmaAllowlist } from '@knowledge/contracts';

/**
 * The figma connector (#470, docs/features/64): the allowlist's spelling, the
 * typed-in token expiry, and the client — 429 back-off and the listing that
 * resolves which files the allowlist reaches. Through a mocked `safeFetch`.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { figmaAllowedFiles, figmaGet } = await import('../src/connectors/adapters/figma.js');
const mockFetch = vi.mocked(safeFetch);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ctx = (config: Record<string, unknown> = {}) => ({
  config,
  credential: 'figd_x',
  allowPrivate: false,
  debug: () => undefined,
  signal: undefined,
});

afterEach(() => {
  mockFetch.mockReset();
  vi.useRealTimers();
});

describe('parseFigmaAllowlist', () => {
  it('reads team and project links, org links and short ids, deduplicated', () => {
    expect(
      parseFigmaAllowlist(
        'https://www.figma.com/files/team/111/Design, https://figma.com/files/project/222/App\n' +
          'https://www.figma.com/files/9876/team/333/Org team:111 project:444',
      ),
    ).toEqual({ teams: ['111', '333'], projects: ['222', '444'], invalid: [] });
  });

  it('echoes what it cannot read', () => {
    expect(parseFigmaAllowlist('https://www.figma.com/design/AbCdEfGhIj12/ team:abc https://evil.test/files/team/1').invalid).toEqual([
      'https://www.figma.com/design/AbCdEfGhIj12/',
      'team:abc',
      'https://evil.test/files/team/1',
    ]);
    expect(parseFigmaAllowlist('')).toEqual({ teams: [], projects: [], invalid: [] });
  });
});

describe('figmaTokenExpiry', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  it.each([
    ['2027-01-31', 'ok'],
    ['2026-11-06', 'soon'],
    ['2026-10-24', 'soon'],
    ['2026-10-23', 'expired'],
    ['', null],
    ['31.01.2027', null],
  ])('%s → %s', (value, state) => expect(figmaTokenExpiry(value, now)).toBe(state));
});

describe('figmaGet', () => {
  it('sends the token and parses JSON', async () => {
    mockFetch.mockResolvedValueOnce(json({ handle: 'ada' }));
    await expect(figmaGet(ctx(), '/v1/me')).resolves.toEqual({ handle: 'ada' });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.figma.com/v1/me');
    expect((init!.headers as Record<string, string>)['X-Figma-Token']).toBe('figd_x');
  });

  it('waits for Retry-After on 429, then gives up after the last attempt', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json({ ok: 1 }));
    const pending = figmaGet(ctx(), '/v1/me');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ ok: 1 });

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(json({}, 429, { 'retry-after': '1' }));
    const failing = figmaGet(ctx(), '/v1/me');
    const assertion = expect(failing).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other refusal', async () => {
    mockFetch.mockResolvedValueOnce(json({ err: 'Invalid token' }, 403));
    await expect(figmaGet(ctx(), '/v1/me')).rejects.toMatchObject({ status: 403 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('figmaAllowedFiles', () => {
  it('expands teams into projects and projects into files', async () => {
    mockFetch.mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/teams/111/projects') return json({ projects: [{ id: 501 }] });
      if (path === '/v1/projects/501/files') return json({ files: [{ key: 'AAAAAAAAAA1', name: 'App' }] });
      if (path === '/v1/projects/222/files') return json({ files: [{ key: 'BBBBBBBBBB2', name: 'Web' }] });
      return json({}, 404);
    });
    await expect(figmaAllowedFiles(ctx({ allowlist: 'team:111 project:222' }))).resolves.toEqual([
      { fileKey: 'BBBBBBBBBB2', name: 'Web', projectId: '222', teamId: null },
      { fileKey: 'AAAAAAAAAA1', name: 'App', projectId: '501', teamId: '111' },
    ]);
  });

  it('reaches nothing with an empty allowlist', async () => {
    await expect(figmaAllowedFiles(ctx())).resolves.toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
