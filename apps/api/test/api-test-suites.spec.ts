import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import { hasCapability, TEST_CASE_CATALOGUE_VERSION } from '@knowledge/contracts';
import { ACCESS_META, type AccessSpec } from '../src/auth/access.decorator.js';
import { AccessService } from '../src/auth/access.service.js';
import type { Principal } from '../src/auth/principal.js';
import { AgentExecutor } from '../src/agents/agent.executor.js';
import { ApiSpecsController } from '../src/api-specs/api-specs.controller.js';
import { ApiTestSuiteRequestsService } from '../src/api-specs/api-test-suite-requests.service.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * QA test suites (#468): the capability gate (route and run), the cache in
 * front of the model, and one run per key in flight.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const KEY = 'op:billing:post /invoices';
const CAP = 'api-test-suites.generate' as const;
const USER: Principal = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'qa@x', displayName: 'QA', avatarUrl: null, mode: 'session', isAdmin: false, locale: 'en' };

function access(member: { role: string; capabilities?: unknown } | null) {
  const prisma = { workspace: { findUnique: async () => ({ deletedAt: null }) }, workspaceMember: { findUnique: vi.fn(async () => (member ? { trustedOperator: false, capabilities: [], ...member } : null)) } };
  return new AccessService(prisma as never, noAuthPolicy);
}

describe('the capability', () => {
  it('is independent of role, implicit for admins, and ignores values outside the catalogue', () => {
    expect(hasCapability({ role: 'viewer', capabilities: [CAP] }, CAP)).toBe(true);
    expect(hasCapability({ role: 'editor', capabilities: [] }, CAP)).toBe(false);
    expect(hasCapability({ role: 'admin', capabilities: [] }, CAP)).toBe(true);
    expect(hasCapability(null, CAP, true)).toBe(true);
    expect(hasCapability({ role: 'editor', capabilities: 'api-test-suites.generate' }, CAP)).toBe(false);
  });

  it('gates Generate at viewer, and leaves reading at plain viewer', async () => {
    const generate = Reflect.getMetadata(ACCESS_META, ApiSpecsController.prototype.generateTestSuite) as AccessSpec;
    const read = Reflect.getMetadata(ACCESS_META, ApiSpecsController.prototype.testSuite) as AccessSpec;
    expect(generate).toMatchObject({ role: 'viewer', source: 'document', capability: CAP });
    expect(read).toEqual({ role: 'viewer', source: 'document', operator: false });

    const opts = { capability: generate.capability };
    await expect(access({ role: 'viewer', capabilities: [CAP] }).requireRole(USER, WS, 'viewer', false, opts)).resolves.toBeUndefined();
    await expect(access({ role: 'editor' }).requireRole(USER, WS, 'viewer', false, opts)).rejects.toThrow(/capabilityRequired/);
    await expect(access({ role: 'admin' }).requireRole(USER, WS, 'viewer', false, opts)).resolves.toBeUndefined();
    await expect(access({ role: 'editor' }).requireRole(USER, WS, 'viewer')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const AT = {
  spec: { revisionId: 'rev-1', title: 'Billing', slug: 'billing', document: {} },
  op: { workspaceId: WS, documentId: DOC, entityKey: KEY, method: 'POST', path: '/invoices' },
  operationHash: 'h',
};
const ROW = {
  documentId: DOC,
  entityKey: KEY,
  revisionId: 'rev-1',
  generatedAt: new Date('2026-10-23T00:00:00Z'),
  generatedBy: USER.userId,
  catalogueVersion: TEST_CASE_CATALOGUE_VERSION,
  cases: [],
};

function requests(cached: boolean) {
  const runs: Array<{ id: string; status: string; subjectKey: string }> = [];
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    agentRun: {
      findFirst: vi.fn(async ({ where }: { where: { subjectKey: string } }) => runs.find((r) => r.subjectKey === where.subjectKey && ['pending', 'running'].includes(r.status)) ?? null),
      create: vi.fn(async ({ data }: { data: { subjectKey: string } }) => {
        const run = { id: `run-${runs.length + 1}`, status: 'pending', subjectKey: data.subjectKey };
        runs.push(run);
        return run;
      }),
    },
    aiAgent: { findUnique: vi.fn(async () => null) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const suites = {
    operationAt: vi.fn(async () => AT),
    find: vi.fn(async () => (cached ? ROW : null)),
    subjectKey: () => 'api-test-suite:k',
    toResponse: (r: typeof ROW) => ({ ...r, generatedAt: r.generatedAt.toISOString() }),
  };
  const agent = { enabled: true, instructions: 'qa', skillIds: [], config: { enabled: true, providerId: null, model: 'm' }, missing: [] };
  const registry = { resolve: vi.fn(async () => agent) };
  const producer = { enqueue: vi.fn(async () => undefined) };
  const usage = { assertWithinBudget: vi.fn(async () => undefined) };
  const service = new ApiTestSuiteRequestsService(prisma as never, suites as never, {} as never, {} as never, {} as never, {} as never, {} as never, registry as never, producer as never, usage as never);
  return { service, runs, producer, usage };
}

describe('Generate', () => {
  it('answers from the cache without a run or a budget check', async () => {
    const r = requests(true);
    const res = await r.service.generate(USER, DOC, KEY, false);
    expect(res).toMatchObject({ suite: { entityKey: KEY }, runId: null });
    expect(r.runs).toHaveLength(0);
    expect(r.usage.assertWithinBudget).not.toHaveBeenCalled();
  });

  it('starts one run per key, and a second click joins it', async () => {
    const r = requests(false);
    const first = await r.service.generate(USER, DOC, KEY, false);
    const second = await r.service.generate(USER, DOC, KEY, false);
    expect(first).toEqual({ suite: null, runId: 'run-1', existing: false });
    expect(second).toEqual({ suite: null, runId: 'run-1', existing: true });
    expect(r.producer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('regenerates past a cached suite', async () => {
    const r = requests(true);
    expect(await r.service.generate(USER, DOC, KEY, true)).toMatchObject({ suite: null, runId: 'run-1' });
    expect(r.usage.assertWithinBudget).toHaveBeenCalledWith(WS, USER.userId);
  });
});

// ---------------------------------------------------------------------------

describe('the tester run', () => {
  function executor(capabilities: string[]) {
    const prisma = {
      workspace: { findUnique: async () => ({ deletedAt: null }) }, workspaceMember: { findUnique: vi.fn(async () => ({ role: 'viewer', trustedOperator: false, capabilities })) },
      agentRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const client = { chat: vi.fn(async () => '{}') };
    const testSuites = { operationAt: vi.fn(), save: vi.fn() };
    const args: unknown[] = Array.from({ length: 24 }, () => ({}));
    args[0] = prisma;
    args[3] = client;
    args[14] = { scopeFor: async () => ({ workspaceId: WS }), requireLevel: async () => 'view' };
    args[22] = new AccessService(prisma as never, noAuthPolicy);
    args[23] = testSuites;
    const ex = new (AgentExecutor as unknown as new (...a: unknown[]) => AgentExecutor)(...args);
    const run = { id: 'run-1', workspaceId: WS, agentKey: 'tester', createdBy: USER.userId, locale: 'en', input: { apiTestSuite: { documentId: DOC, entityKey: KEY, revisionId: 'rev-1' } } } as unknown as AgentRun;
    const agent = { key: 'tester', instructions: 'qa', skillIds: [], config: { enabled: true }, missing: [] };
    return { go: () => ex.run(run, agent as never, USER, async () => undefined), client, testSuites };
  }

  it('fails before any model call when the capability was revoked after the click', async () => {
    const e = executor([]);
    await expect(e.go()).rejects.toThrow(/capabilityRequired/);
    expect(e.client.chat).not.toHaveBeenCalled();
    expect(e.testSuites.save).not.toHaveBeenCalled();
  });
});
