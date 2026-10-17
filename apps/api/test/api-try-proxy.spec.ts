import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';

// The connection's own DNS answers: `rebind.test` turns private between the
// policy check and the dial — the case `safeFetch` exists for.
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns')>();
  const answers: Record<string, string> = { 'rebind.test': '10.0.0.5', 'public.test': '93.184.216.34' };
  return {
    ...real,
    lookup: (host: string, _opts: unknown, cb: (err: Error | null, address: unknown, family?: number) => void) =>
      cb(null, [{ address: answers[host] ?? '93.184.216.34', family: 4 }]),
  };
});

// The policy check's own lookup: `nowhere.test` does not resolve.
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async (host: string, opts?: { all?: boolean }) => {
    if (host === 'nowhere.test') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return opts?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
  };
  return { ...real, lookup, default: { ...real, lookup } };
});

import { API_TRY_MAX_REQUEST_BYTES, type ApiTryRequest } from '@knowledge/contracts';
import { ApiSettingsService } from '../src/api-specs/api-settings.service.js';
import { ApiSpecsController } from '../src/api-specs/api-specs.controller.js';
import { ApiTryService, forwardable, templatePattern, type ApiTryFetch } from '../src/api-specs/api-try.service.js';
import { SourcePolicyService } from '../src/ai/source-policy.service.js';
import { ACCESS_META, type AccessSpec } from '../src/auth/access.decorator.js';
import { AccessService } from '../src/auth/access.service.js';
import type { Principal } from '../src/auth/principal.js';
import { guardedLookup } from '../src/common/safe-fetch.js';

/** The try-it proxy (#78, phase 4): every guard, at the point of action. */

const WS = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const REV = '33333333-3333-4333-8333-333333333333';
const KEY = 'op:billing:get-/invoices/{}';

const SPEC = {
  openapi: '3.1.0',
  servers: [
    { url: 'https://{region}.api.example.com/v1', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
    { url: '/relative' },
  ],
  paths: { '/invoices/{id}': { get: { responses: { '200': { description: 'OK' } } } } },
};

const USER: Principal = {
  userId: '44444444-4444-4444-8444-444444444444',
  email: 'u@example.com',
  displayName: 'U',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};

const ENV: Record<string, unknown> = {
  API_TRY_RATE_PER_MINUTE: 30,
  API_TRY_ALLOW_PRIVATE_URLS: false,
  API_TRY_TIMEOUT_MS: 15_000,
  API_TRY_MAX_RESPONSE_BYTES: 1000,
  API_TRY_PROXY_MODE: 'open',
  WEB_ACCESS_MODE: 'off',
  WEB_ALLOW_PRIVATE_URLS: false,
  WEB_SEARCH_URL: '',
};
const config = { get: (k: string) => ENV[k] };

function build(opts: {
  mode?: 'off' | 'allowlist' | 'open';
  fetcher?: ApiTryFetch;
  spec?: Record<string, unknown>;
  realPolicies?: boolean;
  allowed?: boolean;
}) {
  const prisma = {
    document: { findUnique: vi.fn(async () => ({ workspaceId: WS })) },
    documentRevision: { findUnique: vi.fn(async () => ({ id: REV, documentId: DOC, status: 'indexed' })) },
    apiOperation: {
      findFirst: vi.fn(async ({ where }: { where: { entityKey: string; method: string } }) =>
        where.entityKey === KEY && where.method === 'GET' ? { path: '/invoices/{id}' } : null,
      ),
    },
    sourcePolicy: { findMany: vi.fn(async () => []) },
  };
  const settings = { effectiveTryMode: vi.fn(async () => opts.mode ?? 'open') };
  const reads = { spec: vi.fn(async () => ({ document: opts.spec ?? SPEC })) };
  const policies = opts.realPolicies
    ? new SourcePolicyService(prisma as never, config as never)
    : { decide: vi.fn(async () => (opts.allowed === false ? { ok: false, reason: 'not-allowlisted' } : { ok: true })) };
  const audit = { record: vi.fn(async () => undefined) };
  const limiter = { hit: vi.fn(async () => true) };
  const fetcher = opts.fetcher ?? vi.fn<ApiTryFetch>(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  const service = new ApiTryService(
    prisma as never,
    config as never,
    settings as never,
    reads as never,
    policies as never,
    audit as never,
    limiter as never,
    fetcher,
  );
  return { service, fetcher, audit, limiter, policies };
}

const req = (over: Partial<ApiTryRequest> = {}): ApiTryRequest => ({
  revisionId: REV,
  entityKey: KEY,
  method: 'get',
  url: 'https://us.api.example.com/v1/invoices/inv_1?expand=lines',
  headers: [],
  ...over,
});

describe('ApiTryService', () => {
  it('refuses with 403 while the mode is off, before reading anything else', async () => {
    const { service, fetcher, limiter } = build({ mode: 'off' });
    await expect(service.send(USER, DOC, req())).rejects.toMatchObject({ status: 403, response: { reason: 'proxy-off' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(limiter.hit).not.toHaveBeenCalled();
  });

  it('sends a request to a server of the revision, for the operation it names', async () => {
    const { service, fetcher } = build({});
    const res = await service.send(USER, DOC, req());
    expect(res).toMatchObject({ status: 200, body: '{"ok":true}', encoding: 'utf8', truncated: false });
    const [url, init, allowPrivate] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe('https://us.api.example.com/v1/invoices/inv_1?expand=lines');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', body: undefined });
    expect(allowPrivate).toBe(false);
  });

  it.each([
    ['another host', 'https://evil.example.com/v1/invoices/1'],
    ['a free-form server variable value', 'https://ap.api.example.com/v1/invoices/1'],
    ['outside the server path', 'https://eu.api.example.com/v2/invoices/1'],
    ["another operation's path", 'https://eu.api.example.com/v1/invoices/1/lines'],
    ['an empty path parameter', 'https://eu.api.example.com/v1/invoices/'],
    ['credentials in the URL', 'https://u:p@eu.api.example.com/v1/invoices/1'],
    ['plain http', 'http://eu.api.example.com/v1/invoices/1'],
    ['no URL at all', 'invoices/1'],
  ])('refuses %s with 400', async (_, url) => {
    const { service, fetcher } = build({});
    await expect(service.send(USER, DOC, req({ url }))).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses an operation the revision does not define', async () => {
    const { service } = build({});
    await expect(service.send(USER, DOC, req({ method: 'DELETE' }))).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a spec with only relative servers', async () => {
    const { service } = build({ spec: { ...SPEC, servers: [{ url: '/v1' }] } });
    await expect(service.send(USER, DOC, req())).rejects.toThrow(/relativeServer/);
  });

  it('refuses a private address through the source-policy check', async () => {
    const spec = { ...SPEC, servers: [{ url: 'https://127.0.0.1/v1' }] };
    const { service, fetcher } = build({ spec, realPolicies: true });
    await expect(service.send(USER, DOC, req({ url: 'https://127.0.0.1/v1/invoices/1' }))).rejects.toMatchObject({
      status: 400,
      response: { reason: 'unsafe' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('says a host does not resolve, rather than calling it private', async () => {
    const spec = { ...SPEC, servers: [{ url: 'https://nowhere.test/v1' }] };
    const { service, fetcher } = build({ spec, realPolicies: true });
    await expect(service.send(USER, DOC, req({ url: 'https://nowhere.test/v1/invoices/1' }))).rejects.toMatchObject({
      status: 502,
      message: 'error.apiTry.unresolved',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a host the allowlist does not name with 403', async () => {
    const { service } = build({ mode: 'allowlist', allowed: false });
    await expect(service.send(USER, DOC, req())).rejects.toMatchObject({ status: 403, response: { reason: 'not-allowlisted' } });
  });

  it('reports a name that rebinds to a private address at dial time as 400, not a gateway error', async () => {
    const fetcher = vi.fn<ApiTryFetch>(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EBLOCKEDADDRESS', message: 'blocked' } });
    });
    const { service, audit } = build({ fetcher });
    await expect(service.send(USER, DOC, req())).rejects.toMatchObject({ status: 400, response: { reason: 'unsafe' } });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("the connection's lookup refuses a private answer, and lets a public one through", async () => {
    const ask = (host: string) =>
      new Promise<NodeJS.ErrnoException | null>((resolve) => guardedLookup(host, { all: true }, (err) => resolve(err)));
    await expect(ask('rebind.test')).resolves.toMatchObject({ code: 'EBLOCKEDADDRESS' });
    await expect(ask('public.test')).resolves.toBeNull();
  });

  it('returns a redirect as it came, without following it', async () => {
    const fetcher = vi.fn<ApiTryFetch>(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }));
    const { service } = build({ fetcher });
    const res = await service.send(USER, DOC, req());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(res.headers).toContainEqual({ name: 'location', value: 'https://elsewhere.test/' });
  });

  it('cuts an oversize response at the cap and says so', async () => {
    const fetcher = vi.fn<ApiTryFetch>(async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'text/plain' } }));
    const { service } = build({ fetcher });
    const res = await service.send(USER, DOC, req());
    expect(res).toMatchObject({ truncated: true, bytes: 1000 });
    expect(res.body).toHaveLength(1000);
  });

  it('returns a binary body as base64', async () => {
    const fetcher = vi.fn<ApiTryFetch>(async () => new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'image/png' } }));
    const { service } = build({ fetcher });
    expect(await service.send(USER, DOC, req())).toMatchObject({ encoding: 'base64', body: 'AAEC/w==' });
  });

  it('refuses a request body over the cap with 413', async () => {
    const { service, fetcher } = build({});
    const body = 'x'.repeat(API_TRY_MAX_REQUEST_BYTES + 1);
    await expect(service.send(USER, DOC, req({ body }))).rejects.toMatchObject({ status: 413 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('drops Set-Cookie on the way back, and Cookie / Host on the way out, naming what it dropped', async () => {
    const fetcher = vi.fn<ApiTryFetch>(
      async () => new Response('ok', { headers: { 'set-cookie': 'sid=1', 'x-trace': 't', 'content-type': 'text/plain' } }),
    );
    const { service } = build({ fetcher });
    const res = await service.send(
      USER,
      DOC,
      req({
        headers: [
          { name: 'Authorization', value: 'Bearer secret' },
          { name: 'Cookie', value: 'a=b' },
          { name: 'Host', value: 'internal' },
          { name: 'X-Forwarded-For', value: '1.2.3.4' },
        ],
      }),
    );
    expect(res.headers.map((h) => h.name)).not.toContain('set-cookie');
    expect(res.headers).toContainEqual({ name: 'x-trace', value: 't' });
    expect(res.droppedHeaders).toEqual(['Cookie', 'Host', 'X-Forwarded-For']);
    expect(vi.mocked(fetcher).mock.calls[0][1].headers).toEqual({ authorization: 'Bearer secret' });
  });

  it('audits method, host and path template — never a header, a query or a body', async () => {
    const { service, audit } = build({});
    await service.send(USER, DOC, req({ headers: [{ name: 'Authorization', value: 'Bearer secret' }] }));
    const entry = vi.mocked(audit.record).mock.calls[0][0];
    expect(entry).toMatchObject({
      workspaceId: WS,
      actor: USER.userId,
      action: 'api.try',
      ok: true,
      params: { method: 'GET', host: 'us.api.example.com', path: '/invoices/{id}', status: 200 },
    });
    expect(JSON.stringify(entry)).not.toMatch(/secret|expand|inv_1/);
  });

  it('is counted per user, and refuses with 429 over the limit', async () => {
    const { service, limiter, fetcher } = build({});
    vi.mocked(limiter.hit).mockResolvedValueOnce(false);
    await expect(service.send(USER, DOC, req())).rejects.toMatchObject({ status: 429 });
    expect(limiter.hit).toHaveBeenCalledWith(`api-try:${USER.userId}`, 30, 60_000, false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('turns a timeout into 504', async () => {
    const fetcher = vi.fn<ApiTryFetch>(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    const { service } = build({ fetcher });
    await expect(service.send(USER, DOC, req())).rejects.toMatchObject({ status: 504 });
  });
});

describe('the route', () => {
  it('needs editor, so a read-only key is refused', async () => {
    const spec = Reflect.getMetadata(ACCESS_META, ApiSpecsController.prototype.try) as AccessSpec;
    expect(spec).toMatchObject({ role: 'editor', source: 'document' });
    const prisma = { workspaceMember: { findUnique: vi.fn(async () => ({ role: 'editor', trustedOperator: false })) } };
    const access = new AccessService(prisma as never);
    const readKey: Principal = { ...USER, mode: 'api-key', apiKey: { id: 'k', scope: 'read', workspaceId: null } };
    await expect(access.requireRole(readKey, WS, spec.role)).rejects.toThrow(/apiKeyReadOnly/);
    await expect(access.requireRole({ ...readKey, apiKey: { id: 'k', scope: 'write', workspaceId: null } }, WS, spec.role)).resolves.toBeUndefined();
  });
});

describe('ApiSettingsService.tryProxy', () => {
  const at = (ceiling: string) => new ApiSettingsService({} as never, { get: () => ceiling } as never, {} as never);

  it('inherits the ceiling when nothing is asked for', () => {
    expect(at('allowlist').tryProxy(null)).toEqual({ requested: null, ceiling: 'allowlist', effective: 'allowlist', source: 'env' });
  });

  it('narrows, and says when it clamped a wider request', () => {
    expect(at('open').tryProxy('allowlist')).toMatchObject({ effective: 'allowlist', source: 'db' });
    expect(at('allowlist').tryProxy('open')).toEqual({ requested: 'open', ceiling: 'allowlist', effective: 'allowlist', source: 'clamped' });
    expect(at('off').tryProxy('open')).toMatchObject({ effective: 'off', source: 'clamped' });
  });
});

describe('helpers', () => {
  it('templatePattern: a {param} is one non-empty segment', () => {
    const p = templatePattern('/invoices/{id}/lines/{line}');
    expect(p.test('/invoices/1/lines/2')).toBe(true);
    expect(p.test('/invoices/1/lines/2/')).toBe(true);
    expect(p.test('/invoices/1/x/lines/2')).toBe(false);
    expect(p.test('/invoices//lines/2')).toBe(false);
    expect(templatePattern('/').test('/')).toBe(true);
  });

  it('forwardable: refuses header injection', () => {
    expect(forwardable([{ name: 'X-A', value: 'ok\r\nHost: evil' }, { name: 'bad name', value: 'x' }]).dropped).toEqual(['X-A', 'bad name']);
  });
});
