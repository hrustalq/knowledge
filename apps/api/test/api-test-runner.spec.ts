import { describe, expect, it, vi } from 'vitest';
import { resolveApiTestRunner, type TestRunPlan } from '@knowledge/contracts';
import { ApiTestEnvironmentsService } from '../src/api-specs/api-test-environments.service.js';
import { ApiTestRunProcessor } from '../src/api-specs/api-test-run.processor.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const WS = '11111111-1111-4111-8111-111111111111';

function environments() {
  let row: Record<string, unknown> | null = null;
  const prisma = {
    apiTestEnvironment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (row = { id: 'e1', updatedAt: new Date(), ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (row = { ...row, ...data })),
      findFirst: vi.fn(async () => row),
    },
  };
  const service = new ApiTestEnvironmentsService(prisma as never, { get: () => KEY } as never);
  return { service, stored: () => row! };
}

describe('test environments (#483, phase 5)', () => {
  it('keeps secrets encrypted and write-only, by name', async () => {
    const { service, stored } = environments();
    const info = await service.create(WS, { name: 'Staging', server: 'https://staging.example.com/', inputs: { 'input.currency': 'EUR' }, secrets: { 'secret.qaPassword': 'hunter2' } }, 'u1');
    expect(info).toMatchObject({ server: 'https://staging.example.com', secrets: ['secret.qaPassword'] });
    expect(JSON.stringify(info)).not.toContain('hunter2');
    expect(String(stored().secretsCipher)).toMatch(/^gcm\$/u);
    expect(String(stored().secretsCipher)).not.toContain('hunter2');

    await service.update(WS, 'e1', { secrets: { TOKEN: 'abc', 'secret.qaPassword': null } }, 'u1');
    expect(stored().secretNames).toEqual(['TOKEN']);
    expect(await service.values(WS, 'e1')).toMatchObject({
      values: { 'input.currency': 'EUR' },
      secrets: { TOKEN: 'abc' },
      secretOrigins: ['https://staging.example.com'],
    });
  });

  it('keeps only the secrets a change sets itself when it adds somewhere they may go', async () => {
    const { service, stored } = environments();
    await service.create(WS, { name: 'Staging', server: 'https://staging.example.com/v1', secrets: { TOKEN: 'abc', 'secret.qaPassword': 'hunter2' } }, 'u1');

    // Same origin, a narrower list: nothing new to reach, the secrets stay.
    await service.update(WS, 'e1', { server: 'https://staging.example.com/v2', secretOrigins: [] }, 'u1');
    expect(stored().secretNames).toEqual(['TOKEN', 'secret.qaPassword']);

    await service.update(WS, 'e1', { secretOrigins: ['https://auth.example.com/login'], secrets: { TOKEN: 'new' } }, 'u1');
    expect(stored().secretOrigins).toEqual(['https://auth.example.com']);
    expect((await service.values(WS, 'e1'))?.secrets).toEqual({ TOKEN: 'new' });

    await service.update(WS, 'e1', { server: 'https://elsewhere.example.com' }, 'u1');
    expect(stored().secretNames).toEqual([]);
    expect(stored().secretsCipher).toBeNull();
    await expect(service.update(WS, 'e1', { secretOrigins: ['ftp://x.example.com'] }, 'u1')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a URL with credentials and a name no plan uses', async () => {
    const { service } = environments();
    await expect(service.create(WS, { name: 'x', server: 'https://u:p@h.example.com' }, 'u1')).rejects.toMatchObject({ status: 400 });
    await expect(service.create(WS, { name: 'x', inputs: { 'bad name': 'v' } }, 'u1')).rejects.toMatchObject({ status: 400 });
  });

  it('is on only when the deployment and the workspace both say on', () => {
    expect(resolveApiTestRunner(null, 'on').effective).toBe('off');
    expect(resolveApiTestRunner('on', 'off').effective).toBe('off');
    expect(resolveApiTestRunner('on', 'on').effective).toBe('on');
  });
});

const target = (documentId: string, server: string) => ({ documentId, revisionId: `${documentId}-rev`, entityKey: `op:${documentId}`, server });
const PLAN: TestRunPlan = {
  documentId: 'billing',
  entityKey: 'op:billing',
  title: 'GET /invoices/{id}',
  setup: [
    {
      id: 'login',
      kind: 'call',
      label: 'Login › login',
      target: target('auth', 'https://auth.example.com'),
      request: { method: 'POST', url: 'https://auth.example.com/sessions', headers: [], body: '{"p":"{{secret.qaPassword}}"}' },
      expect: '201',
      capture: { TOKEN: '$.token', userId: '$.user' },
    },
  ],
  cases: [
    {
      id: 'ok',
      kind: 'positive',
      name: 'Gets the invoice',
      target: target('billing', 'https://api.example.com'),
      request: { method: 'GET', url: 'https://api.example.com/invoices/1', headers: [{ name: 'Authorization', value: 'Bearer {{TOKEN}}' }], body: null },
      expect: '200',
      setup: [],
      teardown: [],
      captures: [],
    },
  ],
  teardown: [],
  inputs: {},
  secrets: ['secret.qaPassword'],
};

function processor(opts: { runnerOn?: boolean; secretOrigins?: string[] } = {}) {
  const finish = vi.fn(async () => undefined);
  const runs = {
    claim: vi.fn(async () => ({ id: 'r1', workspaceId: WS, documentId: 'billing', environmentId: 'e1', createdBy: 'u1', plan: PLAN })),
    assertOn: vi.fn(async () => {
      if (opts.runnerOn === false) throw new Error('off');
    }),
    finish,
  };
  const environments = {
    values: vi.fn(async () => ({
      name: 'Staging',
      server: 'https://staging.example.com',
      values: {},
      secrets: { 'secret.qaPassword': 'hunter2' },
      secretOrigins: opts.secretOrigins ?? ['https://staging.example.com', 'https://auth.example.com'],
    })),
  };
  const sent: Array<{ actor: string; url: string; body: string | null | undefined }> = [];
  const tries = {
    sendAs: vi.fn(async (actor: string, _doc: string, req: { url: string; body?: string | null }, metered: boolean) => {
      expect(metered).toBe(false);
      sent.push({ actor, url: req.url, body: req.body });
      return req.url.endsWith('/sessions')
        ? { status: 201, headers: [], body: '{"token":"t0k","user":"u-9"}', encoding: 'utf8', durationMs: 3 }
        : { status: 200, headers: [], body: '{}', encoding: 'utf8', durationMs: 2 };
    }),
  };
  // Only the billing spec declares staging; auth keeps its own server.
  const reads = {
    spec: vi.fn(async (doc: string) => ({
      document: { servers: doc === 'billing' ? [{ url: 'https://api.example.com' }, { url: 'https://staging.example.com' }] : [{ url: 'https://auth.example.com' }] },
    })),
  };
  const access = { principalFor: vi.fn(async () => ({ userId: 'u1' })), requireRole: vi.fn(async () => undefined) };
  const permissions = { scopeFor: vi.fn(async () => ({ workspaceId: WS })), requireLevel: vi.fn(async () => 'view') };
  const p = new ApiTestRunProcessor(runs as never, environments as never, tries as never, reads as never, access as never, permissions as never);
  return { p, finish, sent, access, permissions };
}

describe('the server runner (#483, phase 5)', () => {
  it('sends as the run owner, to the environment server only where the spec declares it, and stores no secret capture', async () => {
    const { p, finish, sent, access, permissions } = processor();
    await p.process({ data: { runId: 'r1' } } as never);
    expect(access.requireRole).toHaveBeenCalledWith(expect.anything(), WS, 'viewer', false, { capability: 'api-test-suites.run' });
    expect(permissions.requireLevel).toHaveBeenCalledWith(expect.anything(), { type: 'document', id: 'auth' }, 'view');
    expect(sent.map((s) => s.url)).toEqual(['https://auth.example.com/sessions', 'https://staging.example.com/invoices/1']);
    expect(sent.every((s) => s.actor === 'u1')).toBe(true);
    expect(sent[0].body).toContain('hunter2');
    const out = finish.mock.calls[0][1] as { status: string; results: Record<string, { captures: Record<string, string> }> };
    expect(out.status).toBe('passed');
    expect(out.results['setup/login'].captures).toEqual({ userId: 'u-9' });
    expect(JSON.stringify(out)).not.toContain('t0k');
  });

  it('does not send a step whose secret the environment does not allow on that host', async () => {
    const { p, finish, sent } = processor({ secretOrigins: ['https://staging.example.com'] });
    await p.process({ data: { runId: 'r1' } } as never);
    expect(sent).toEqual([]);
    const out = finish.mock.calls[0][1] as { status: string; results: Record<string, { outcome: string; reason: string | null }> };
    expect(out.results['setup/login']).toMatchObject({ outcome: 'error', reason: 'withheld:secret.qaPassword' });
    expect(out.results['case/ok'].outcome).toBe('not-run');
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('errors without sending when the runner was turned off after the click', async () => {
    const { p, finish, sent } = processor({ runnerOn: false });
    await p.process({ data: { runId: 'r1' } } as never);
    expect(sent).toEqual([]);
    expect(finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'error' }));
  });
});
