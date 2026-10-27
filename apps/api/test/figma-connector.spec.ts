import { afterEach, describe, expect, it, vi } from 'vitest';
import { figmaTokenExpiry, parseFigmaAllowlist } from '@knowledge/contracts';

/**
 * The figma connector (#470, docs/features/64): the allowlist's spelling, the
 * typed-in token expiry, and the client — 429 back-off and the listing that
 * resolves which files the allowlist reaches. Through a mocked `safeFetch`.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
// The key and its arguments, so a test can see what the message names.
vi.mock('../src/i18n/t.js', () => ({ t: (key: string, args?: object) => `${key} ${JSON.stringify(args ?? {})}` }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { figmaAllowedFiles, figmaGet } = await import('../src/connectors/adapters/figma.js');
const { FigmaAdapter } = await import('../src/connectors/adapters/figma.adapter.js');
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

  it('reads folder links and ids as projects, the same id under its new name (#549)', () => {
    expect(parseFigmaAllowlist('folder:555 https://www.figma.com/files/9876/folder/666/Web https://figma.com/files/folder/777')).toEqual({
      teams: [],
      projects: ['555', '666', '777'],
      invalid: [],
    });
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
  const byPath = (paths: Record<string, unknown>) =>
    mockFetch.mockImplementation(async (url) => {
      const body = paths[new URL(String(url)).pathname];
      return body ? json(body) : json({}, 404);
    });

  it('walks team → folder → subfolder → files on the v2 folder endpoints (#549)', async () => {
    byPath({
      '/v2/teams/111/folders': { name: 'Design', folders: [{ id: '501', parent_folder_id: null }] },
      '/v2/folders/501/folders': { name: 'App', folders: [{ id: '502', parent_folder_id: '501' }] },
      '/v2/folders/502/folders': { name: 'Flows', folders: [] },
      '/v2/folders/222/folders': { name: 'Web', folders: [] },
      '/v2/folders/501/files': { name: 'App', files: [{ key: 'AAAAAAAAAA1', name: 'App' }] },
      '/v2/folders/502/files': { name: 'Flows', files: [{ key: 'CCCCCCCCCC3', name: 'Sign-in' }] },
      '/v2/folders/222/files': { name: 'Web', files: [{ key: 'BBBBBBBBBB2', name: 'Web' }] },
    });
    await expect(figmaAllowedFiles(ctx({ allowlist: 'team:111 project:222' }))).resolves.toEqual([
      { fileKey: 'AAAAAAAAAA1', name: 'App', projectId: '501', teamId: '111' },
      { fileKey: 'BBBBBBBBBB2', name: 'Web', projectId: '222', teamId: null },
      // Stored under the folder the allowlist reached, so the read-time check needs no tree.
      { fileKey: 'CCCCCCCCCC3', name: 'Sign-in', projectId: '501', teamId: '111' },
    ]);
    expect(mockFetch.mock.calls.every(([url]) => new URL(String(url)).pathname.startsWith('/v2/'))).toBe(true);
  });

  it('walks a folder reached twice once', async () => {
    byPath({
      '/v2/folders/222/folders': { name: 'Web', folders: [{ id: '223' }] },
      '/v2/folders/223/folders': { name: 'Sub', folders: [] },
      '/v2/folders/222/files': { name: 'Web', files: [] },
      '/v2/folders/223/files': { name: 'Sub', files: [{ key: 'DDDDDDDDDD4', name: 'Sub' }] },
    });
    await expect(figmaAllowedFiles(ctx({ allowlist: 'project:222 folder:223' }))).resolves.toEqual([
      { fileKey: 'DDDDDDDDDD4', name: 'Sub', projectId: '223', teamId: null },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('reaches nothing with an empty allowlist', async () => {
    await expect(figmaAllowedFiles(ctx())).resolves.toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('FigmaAdapter.testConnection (#545)', () => {
  const test = (byPath: Record<string, Response>) => {
    mockFetch.mockImplementation(async (url) => byPath[new URL(String(url)).pathname]?.clone() ?? json({}, 404));
    return new FigmaAdapter().testConnection(ctx({ allowlist: 'team:111' }) as never);
  };

  it('passes without current_user:read, leaving out the handle', async () => {
    const result = await test({
      '/v1/me': json({ status: 403, err: 'Invalid scope' }, 403),
      '/v2/teams/111/folders': json({ name: 'Design', folders: [{ id: '501', parent_folder_id: null }] }),
      '/v2/folders/501/folders': json({ name: 'App', folders: [] }),
      '/v2/folders/501/files': json({ name: 'App', files: [{ key: 'AAAAAAAAAA1', name: 'App' }] }),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/^connector\.figmaReach/);
  });

  it("names the allowlist entry, the scope and Figma's own reason when Figma refuses a listing", async () => {
    const refused = test({ '/v1/me': json({ handle: 'ada' }), '/v2/teams/111/folders': json({ status: 403, err: 'Invalid scope(s): projects:read' }, 403) });
    await expect(refused).rejects.toThrow(
      'error.connector.figmaListRefused {"entry":"team:111","scope":"folders:read","reason":"Invalid scope(s): projects:read"}',
    );
  });

  it('still fails on a bad token', async () => {
    await expect(test({ '/v1/me': json({ status: 401, err: 'Invalid token' }, 401) })).rejects.toMatchObject({ status: 401 });
  });
});
