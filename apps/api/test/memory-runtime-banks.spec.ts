import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { MemoryBank } from '@prisma/client';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import {
  MemoryBanksService,
  holdsRuntimeIdentity,
  readConfigUpdates,
} from '../src/memory/memory-banks.service.js';
import { personalMemoryBankId, projectMemoryBankId } from '../src/memory/memory-runtime.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const caller = { principal: { ...DEV_PRINCIPAL, userId: USER }, workspaceId: WS, scope: { userId: USER } as never };

const personal = { bankId: personalMemoryBankId('researcher', USER), projectId: null, agentKey: 'researcher', ownerId: USER, name: 'p', mission: '' };
const project = { bankId: projectMemoryBankId(PROJECT), projectId: PROJECT, agentKey: null, ownerId: null, name: 'Project memory', mission: '' };

function service(existing: Partial<MemoryBank> | null) {
  const prisma = {
    memoryBank: {
      findUnique: vi.fn(async () => existing),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    },
  };
  const access = { find: vi.fn(async () => null), bank: vi.fn() };
  const svc = new MemoryBanksService(prisma as never, access as never, { record: vi.fn(async () => undefined) } as never, {} as never, {} as never);
  return { svc, prisma, access };
}

describe('reserved bank ids (squatting)', () => {
  it('a wire caller cannot create a bank under a runtime id; any other id is created', async () => {
    for (const bankId of [personal.bankId, project.bankId]) {
      const { svc, prisma } = service(null);
      await expect(svc.ensure(caller, bankId)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.memoryBank.create).not.toHaveBeenCalled();
    }
    const { svc, prisma } = service(null);
    await svc.ensure(caller, 'my-notes');
    expect(prisma.memoryBank.create).toHaveBeenCalledOnce();
  });

  it('the runtime creates its own bank with the identity it names, and reads it only by its id', async () => {
    const { svc, prisma, access } = service(null);
    const row = await svc.runtimeBank(caller, personal, { create: true });
    expect(row).toMatchObject({ bankId: personal.bankId, ownerId: USER, agentKey: 'researcher', projectId: null });
    expect(prisma.memoryBank.create).toHaveBeenCalledOnce();
    // Never through an alias: `find` resolves aliases, the runtime does not ask it.
    expect(access.find).not.toHaveBeenCalled();
    expect(await service(null).svc.runtimeBank(caller, personal, { create: false })).toBeNull();
  });

  it('a row under the runtime id that holds another identity is not the runtime’s bank', async () => {
    const squats: Array<[typeof personal | typeof project, Partial<MemoryBank>]> = [
      [personal, { ...personal, ownerId: null, agentKey: null }],
      [personal, { ...personal, ownerId: OTHER }],
      [project, { ...project, ownerId: OTHER }],
      [project, { ...project, projectId: null }],
      [project, { ...project, projectId: OTHER }],
    ];
    for (const [target, row] of squats) {
      const { svc, prisma } = service({ id: 'squat', ...row });
      expect(await svc.runtimeBank(caller, target, { create: true })).toBeNull();
      expect(prisma.memoryBank.create).not.toHaveBeenCalled();
    }
    expect(await service({ id: 'mine', ...project }).svc.runtimeBank(caller, project, { create: false })).toMatchObject({ id: 'mine' });
    expect(holdsRuntimeIdentity(personal, personal)).toBe(true);
  });
});

describe('consolidation_strategies caps', () => {
  const current = { disposition: {} } as MemoryBank;
  const strategies = (value: unknown) => () => readConfigUpdates({ consolidation_strategies: value }, current);

  it('accepts a bounded list and refuses too many strategies, rules, tags or a long pattern', () => {
    expect(strategies([{ scopes: [{ tags: ['team:*'] }] }])).not.toThrow();
    expect(strategies(Array.from({ length: 21 }, () => ({})))).toThrow(BadRequestException);
    expect(strategies([{ scopes: Array.from({ length: 21 }, () => ({ tags: ['a'] })) }])).toThrow(BadRequestException);
    expect(strategies([{ scopes: [{ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }] }])).toThrow(BadRequestException);
    expect(strategies([{ scopes: [{ tags: ['*'.repeat(101)] }] }])).toThrow(BadRequestException);
    expect(strategies([{ scopes: [{ tags: ['a'.repeat(100)] }] }])).not.toThrow();
  });
});
