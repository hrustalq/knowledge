import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { isMemoryPath, memoryErrorBody } from '../src/common/memory-error-body.js';
import { AccessService } from '../src/auth/access.service.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { MemoryAccessService } from '../src/memory/memory-access.service.js';
import type { AccessScope } from '../src/permissions/access-scope.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';

const keyed = (apiKey: Partial<NonNullable<Principal['apiKey']>>): Principal => ({
  ...DEV_PRINCIPAL,
  mode: 'api-key',
  isAdmin: false,
  userId: 'u1',
  apiKey: { id: 'k1', scope: 'write', workspaceId: WS, ...apiKey },
});

const scope = (over: Partial<AccessScope> = {}): AccessScope => ({
  workspaceId: WS,
  userId: 'u1',
  role: 'editor',
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set(),
  denied: new Set(),
  granted: new Set(),
  ...over,
});

function service(opts: { off?: 'server' | 'workspace'; bank?: { projectId: string | null } | null; restricted?: boolean; scope?: AccessScope } = {}) {
  const prisma = {
    workspace: { findUnique: vi.fn(async () => ({ id: WS, deletedAt: null })) },
    workspaceMember: { findUnique: vi.fn(async () => ({ role: 'editor', trustedOperator: false })) },
    memoryBank: { findUnique: vi.fn(async () => (opts.bank ? { id: 'b1', bankId: 'agent', ...opts.bank } : null)) },
    project: { findMany: vi.fn(async () => (opts.restricted ? [{ id: PROJECT }] : [])) },
  };
  // The real key rule and role ladder, over a fake roster: the resolver must ask them, not restate them.
  const access = new AccessService(prisma as never, { enforce: vi.fn() } as never);
  const features = {
    unavailable: () => (opts.off === 'server' ? ['memory'] : []),
    require: vi.fn(async () => {
      if (opts.off === 'workspace') throw new NotFoundException('off');
    }),
  };
  const permissions = { scopeFor: vi.fn(async () => opts.scope ?? scope()) };
  return { prisma, features, svc: new MemoryAccessService(prisma as never, access, features as never, permissions as never) };
}

describe('memory request resolver (#986)', () => {
  it('means the key’s pinned workspace by `default`, and refuses a key or session with none', async () => {
    expect((await service().svc.caller(keyed({}), undefined, 'viewer')).workspaceId).toBe(WS);
    await expect(service().svc.caller(keyed({ workspaceId: null }), undefined, 'viewer')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service().svc.caller({ ...keyed({}), apiKey: undefined, mode: 'session' }, WS, 'viewer')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never reads a workspace header from a key, and needs one under AUTH_MODE=none', async () => {
    expect((await service().svc.caller(keyed({}), OTHER, 'viewer')).workspaceId).toBe(WS);
    expect((await service().svc.caller(DEV_PRINCIPAL, OTHER, 'editor')).workspaceId).toBe(OTHER);
    await expect(service().svc.caller(DEV_PRINCIPAL, undefined, 'viewer')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service().svc.caller(DEV_PRINCIPAL, 'not-a-uuid', 'viewer')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a write key retain, a capture key only where the route says so, a read key never', async () => {
    await expect(service().svc.caller(keyed({}), undefined, 'editor')).resolves.toBeTruthy();
    await expect(service().svc.caller(keyed({ scope: 'capture' }), undefined, 'editor', { capture: true })).resolves.toBeTruthy();
    await expect(service().svc.caller(keyed({ scope: 'capture' }), undefined, 'editor')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service().svc.caller(keyed({ scope: 'read' }), undefined, 'editor', { capture: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service().svc.caller(keyed({ scope: 'read' }), undefined, 'viewer')).resolves.toBeTruthy();
  });

  it('answers 404 with the server ceiling off before reading anything, and with the section off', async () => {
    const off = service({ off: 'server' });
    await expect(off.svc.caller(keyed({ workspaceId: null }), undefined, 'viewer')).rejects.toBeInstanceOf(NotFoundException);
    expect(off.prisma.workspace.findUnique).not.toHaveBeenCalled();
    await expect(service({ off: 'workspace' }).svc.caller(keyed({}), undefined, 'viewer')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides a bank bound to a restricted project from a scope the project denies', async () => {
    const caller = (s: AccessScope) => ({ principal: keyed({}), workspaceId: WS, scope: s });
    const bound = { bank: { projectId: PROJECT }, restricted: true };
    await expect(service(bound).svc.bank(caller(scope({ denied: new Set([PROJECT]) })), 'agent')).rejects.toBeInstanceOf(NotFoundException);
    // Hidden is not absent: `find` must not report it as free to create.
    await expect(service(bound).svc.find(caller(scope({ denied: new Set([PROJECT]) })), 'agent')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service(bound).svc.bank(caller(scope()), 'agent')).resolves.toMatchObject({ bankId: 'agent' });
    await expect(service({ bank: null }).svc.find(caller(scope()), 'agent')).resolves.toBeNull();
    await expect(service().svc.find(caller(scope()), 'bad\nid')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('memory error body (#986)', () => {
  it('recognises the Hindsight paths and nothing of ours', () => {
    for (const url of ['/v1/default/banks', '/v1/default/banks/x/memories/recall?a=1', '/mcp/agent/', '/mcp', '/mcp?x=1', '/version', '/health?x=1']) expect(isMemoryPath(url)).toBe(true);
    for (const url of ['/v1/documents', '/v1/mcp', '/v1/mcp/skill', '/v1/defaults', '/versions', '/mcps', '/']) expect(isMemoryPath(url)).toBe(false);
  });

  it('carries a message as `detail`, and a failed validation as FastAPI’s 422 list', () => {
    expect(memoryErrorBody(404, 'gone')).toEqual({ status: 404, body: { detail: 'gone' } });
    expect(memoryErrorBody(400, 'Validation failed', ['a must be x'])).toEqual({
      status: 422,
      body: { detail: [{ loc: ['body'], msg: 'a must be x', type: 'value_error' }] },
    });
  });
});
