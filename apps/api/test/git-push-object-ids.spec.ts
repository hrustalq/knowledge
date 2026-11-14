import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const runGit = vi.hoisted(() => vi.fn(async (_args: string[]) => Buffer.alloc(0)));
vi.mock('../src/git/git-repo.service.js', async (load) => ({ ...(await load<object>()), runGit }));

const { GitPushService } = await import('../src/git/git-push.service.js');
const { systemScope } = await import('../src/permissions/access-scope.js');

// GHSA-4xqc-5p3w-3v95: a receive-pack command's ids reach git's argv, so
// anything but 40 hex characters is refused before git runs at all.
const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'git-push-ids-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const body = (oldSha: string, newSha: string) => Buffer.from(`${pkt(`${oldSha} ${newSha} refs/heads/main\0report-status\n`)}0000`);

function service() {
  const view = { branchRefs: () => new Map([['main', OLD]]) };
  const repos = {
    withRepo: vi.fn(async (_ws: string, _p: string, _s: unknown, _w: boolean, fn: (r: unknown) => Promise<unknown>) =>
      fn({ dir: join(root, 'repo'), view, project: { model: { heads: new Map() }, defaultBranch: 'main' } }),
    ),
  };
  const access = { requireRole: vi.fn(async () => undefined) };
  const config = { get: (key: string) => ({ GIT_CACHE_DIR: root, WEB_BASE_URL: 'https://kn.test' })[key] };
  const svc = new GitPushService({} as never, {} as never, repos as never, {} as never, {} as never, {} as never, {} as never, access as never, {} as never, {} as never, config as never);
  const caller = { principal: { userId: 'u', apiKey: null }, scope: systemScope(WS) };
  return { receive: (b: Buffer) => svc.receive(WS, PROJECT, caller as never, b), repos };
}

beforeEach(() => {
  runGit.mockClear();
});

describe('git push object ids', () => {
  it.each([
    ['newSha', OLD, '--output=/tmp/owned'],
    ['newSha', OLD, 'HEAD'],
    ['newSha', OLD, NEW.toUpperCase()],
    ['oldSha', '-' + OLD.slice(1), NEW],
  ])('a malformed %s is refused before any git process starts', async (_field, oldSha, newSha) => {
    const { receive, repos } = service();
    const out = (await receive(body(oldSha, newSha))).toString();
    expect(out).toContain('ng refs/heads/main');
    expect(repos.withRepo).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it('a well-formed command reaches git, with revisions after --end-of-options', async () => {
    const { receive } = service();
    await receive(body(OLD, NEW));
    const mergeBase = runGit.mock.calls.map(([args]) => args).find((args) => args.includes('merge-base'));
    expect(mergeBase).toBeDefined();
    expect(mergeBase!.indexOf('--end-of-options')).toBeLessThan(mergeBase!.indexOf(NEW));
  });
});

describe('git push blob size (#1107)', () => {
  const BLOB = 'c'.repeat(40);
  it('asks a blob its size and refuses one over the ceiling without reading it', async () => {
    runGit.mockImplementation(async (args: string[]) => {
      const a = args.slice(2);
      if (a[0] === 'rev-list') return Buffer.from(`${NEW}\n`);
      if (a[0] === 'cat-file' && a[1] === 'commit') return Buffer.from(`tree ${'d'.repeat(40)}\nparent ${OLD}\nauthor a <a> 1 +0000\n\nBig\n`);
      if (a[0] === 'diff-tree') return Buffer.from(`:000000 100644 ${'0'.repeat(40)} ${BLOB} A\0big.md\0`);
      if (a[0] === 'cat-file' && a[1] === '-s') return Buffer.from('900000000\n');
      return Buffer.alloc(0);
    });
    const view = { branchRefs: () => new Map([['main', OLD]]), idOf: () => 'c1', index: () => new Map() };
    const repos = {
      withRepo: vi.fn(async (_ws: string, _p: string, _s: unknown, _w: boolean, fn: (r: unknown) => Promise<unknown>) =>
        fn({ dir: join(root, 'repo'), view, project: { model: { heads: new Map([['main', 'c1']]) }, defaultBranch: 'main', blobs: new Map() } }),
      ),
    };
    const config = { get: (key: string) => ({ GIT_CACHE_DIR: root, WEB_BASE_URL: 'https://kn.test', REVISION_MAX_BYTES: 1_000_000 })[key] };
    const svc = new GitPushService({} as never, {} as never, repos as never, {} as never, {} as never, {} as never, {} as never, { requireRole: vi.fn(async () => undefined) } as never, {} as never, {} as never, config as never);
    const out = (await svc.receive(WS, PROJECT, { principal: { userId: 'u', apiKey: null }, scope: systemScope(WS) } as never, body(OLD, NEW))).toString();
    expect(out).toContain('ng refs/heads/main too large');
    const calls = runGit.mock.calls.map(([args]) => args.slice(2));
    expect(calls).toContainEqual(['cat-file', '-s', BLOB]);
    expect(calls.some((a) => a[0] === 'cat-file' && a[1] === 'blob')).toBe(false);
    expect(runGit.mock.calls.find(([args]) => args.includes('index-pack'))?.[0]).toBeUndefined();
  });
});
