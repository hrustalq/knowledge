import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Branch resolution and 404 classification (#28).
 *
 * Both behaviours are defined entirely by which requests go out and what comes
 * back, so `safeFetch` is the seam: mocking it covers the direct metadata probe
 * *and* the archive download, since `connectorFetch` goes through the same
 * function. Nothing here touches the network or Nest.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { downloadRepoArchive, resolveBranch } = await import('../src/connectors/adapters/repo-archive.js');
const mockFetch = vi.mocked(safeFetch);

/**
 * A context is one object per connector row per run, and both caches in
 * repo-archive are keyed on its `config`. Building a fresh one per test is what
 * keeps them from leaking across cases.
 */
function ctx(config: Record<string, string>) {
  return {
    connectorId: 'c1',
    workspaceId: 'w1',
    // Copied, never shared: both caches in repo-archive are keyed on this
    // object's identity, so reusing one literal across cases would let a
    // resolved branch leak into the next test.
    config: { ...config },
    credential: null as string | null,
    onStage: async () => undefined,
    debug: () => undefined,
    allowPrivate: false,
    userId: null,
    locale: 'en' as const,
  };
}

const GH = { repoUrl: 'https://github.com/acme/service' };

/**
 * `headers` is not optional padding: `connectorFetch` builds its debug trace
 * eagerly, so `res.headers.get('content-length')` is evaluated even when the
 * trace itself is a no-op.
 */
function json(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => '',
  } as Response;
}

function notFound() {
  return {
    ok: false,
    status: 404,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => '404: Not Found',
  } as Response;
}

beforeEach(() => mockFetch.mockReset());

describe('resolveBranch', () => {
  it('uses the configured branch and asks GitHub nothing', async () => {
    await expect(resolveBranch(ctx({ ...GH, branch: 'release' }))).resolves.toBe('release');
    // The acceptance criterion from #28: a healthy configured sync costs no
    // extra request at all.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to the repository default when Branch is left empty', async () => {
    mockFetch.mockResolvedValueOnce(json({ default_branch: 'dev' }));
    // The reported repository defaults to `dev`; this used to answer 'main'.
    await expect(resolveBranch(ctx(GH))).resolves.toBe('dev');
  });

  it('resolves once per run even when asked repeatedly', async () => {
    mockFetch.mockResolvedValue(json({ default_branch: 'trunk' }));
    const c = ctx(GH);
    const [a, b] = await Promise.all([resolveBranch(c), resolveBranch(c)]);

    expect([a, b]).toEqual(['trunk', 'trunk']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('answers main when the probe fails, leaving the real error to the caller', async () => {
    mockFetch.mockResolvedValueOnce(notFound());
    await expect(resolveBranch(ctx(GH))).resolves.toBe('main');
  });

  it('treats a whitespace-only branch as empty', async () => {
    mockFetch.mockResolvedValueOnce(json({ default_branch: 'main-line' }));
    await expect(resolveBranch(ctx({ ...GH, branch: '   ' }))).resolves.toBe('main-line');
  });
});

describe('downloadRepoArchive 404 classification', () => {
  it('names the missing credential when the repository cannot be seen at all', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound()) // the archive
      .mockResolvedValueOnce(notFound()); // the classifying probe

    await expect(downloadRepoArchive(ctx({ ...GH, branch: 'main' }))).rejects.toThrow(
      /no credential is configured/,
    );
  });

  it('points at access rather than absence when a credential was supplied', async () => {
    mockFetch.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(notFound());

    const c = { ...ctx({ ...GH, branch: 'main' }), credential: 'ghp_token' };
    await expect(downloadRepoArchive(c)).rejects.toThrow(/cannot read it/);
  });

  it('names the branch and the real default when the repository is reachable', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(json({ default_branch: 'dev' }));

    // The exact case in the report: a connector pinned to `main` against a
    // repository whose default is `dev`.
    await expect(downloadRepoArchive(ctx({ ...GH, branch: 'main' }))).rejects.toThrow(
      /branch "main" does not exist.*default branch is "dev"/s,
    );
  });

  it('leaves a non-404 alone — a 401 or a 500 already says what it is', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => 'Bad credentials',
    } as Response);

    await expect(downloadRepoArchive(ctx({ ...GH, branch: 'main' }))).rejects.toThrow(/401/);
    // Only the archive request; a non-404 must not pay for the probe.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not probe a host that has no API to probe', async () => {
    mockFetch.mockResolvedValueOnce(notFound());

    const c = ctx({ repoUrl: 'https://git.example.com/acme/service', branch: 'main' });
    await expect(downloadRepoArchive(c)).rejects.toThrow(/404/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
