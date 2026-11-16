import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MemoryUnitsService } from '../src/memory/memory-units.service.js';
import { MAX_UPLOAD_REQUEST_BYTES, MemoryUploadGuard } from '../src/memory/memory-upload.guard.js';

const bank = { id: 'bank-1', workspaceId: 'ws-1', bankId: 'mine' } as never;

describe('memory document routes (#1161)', () => {
  it('refuses the graph and files wires\' document ids on PATCH and DELETE, touching nothing', async () => {
    const prisma = { memoryUnit: { findMany: vi.fn(async () => []) } };
    const units = new MemoryUnitsService(prisma as never, {} as never);
    for (const id of ['file:/notes.md', 'graph:e1:1']) {
      await expect(units.deleteDocument(bank, id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(units.updateDocument(bank, id, { tags: ['x'] } as never)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.memoryUnit.findMany).not.toHaveBeenCalled();
  });

  it('answers 404 for an observation history id that is not a uuid, without a query', async () => {
    const prisma = { memoryUnit: { findFirst: vi.fn() } };
    await expect(new MemoryUnitsService(prisma as never, {} as never).observationHistory(bank, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.memoryUnit.findFirst).not.toHaveBeenCalled();
  });

  it('resets only the (source, scope) pairs an invalidated observation stood on (#1166)', async () => {
    // o1 (scope s1) stood on f1 and f2; o2 (scope s2) on f3. Deleting f1 resets f1+f2 in s1 and f3 in s2 — never f2 in s2.
    const affected = [
      { id: 'o1', observationScopeId: 's1', evidence: [{ factId: 'f1' }, { factId: 'f2' }] },
      { id: 'o2', observationScopeId: 's2', evidence: [{ factId: 'f3' }] },
    ];
    const members = { updateMany: vi.fn(async () => ({ count: 0 })) };
    const prisma = { memoryUnit: { findMany: vi.fn(async () => affected), deleteMany: vi.fn(), updateMany: vi.fn() }, memoryObservationScopeMember: members };
    expect(await new MemoryUnitsService(prisma as never, {} as never).invalidateFacts('bank-1', ['f1'])).toEqual(['o1', 'o2']);
    expect(members.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ unitId: { in: ['f1', 'f2'] }, scopeId: 's1' }, { unitId: { in: ['f3'] }, scopeId: 's2' }] },
      data: { consolidatedAt: null, claimedAt: null },
    });
  });

  it('gives a chunk its source text\'s index, though several units share one text (#1166)', async () => {
    const unit = (id: string, sourceText: string) => ({ id, documentId: 'd1', sourceText, createdAt: new Date(0) });
    const siblings = [unit('u1', 'A'), unit('u2', 'B'), unit('u3', 'B')];
    const prisma = { memoryUnit: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => siblings.find((u) => u.id === where.id)), findMany: vi.fn(async () => siblings) } };
    const units = new MemoryUnitsService(prisma as never, {} as never);
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    siblings.forEach((u, i) => (u.id = id(i + 1)));
    expect((await units.chunk(bank, id(2))).chunk_index).toBe(1);
    expect((await units.chunk(bank, id(3))).chunk_index).toBe(1);
    expect((await units.chunk(bank, id(1))).chunk_index).toBe(0);
  });

  it('filters tags by a glob pattern', async () => {
    const prisma = { memoryUnit: { findMany: vi.fn(async () => [{ tags: ['user:alice', 'team'] }, { tags: ['User:Bob'] }]) } };
    const page = await new MemoryUnitsService(prisma as never, {} as never).tags(bank, { q: 'user:*' } as never);
    expect(page.items.map((row) => row.tag).sort()).toEqual(['User:Bob', 'user:alice']);
  });
});

describe('MemoryUploadGuard (#1161)', () => {
  const context = (headers: Record<string, string>) => ({ switchToHttp: () => ({ getRequest: () => ({ principal: { userId: 'u1' }, header: (name: string) => headers[name] }) }) }) as never;

  it('resolves the caller as an editor before the body is read, and refuses an undeclared or oversized body', async () => {
    const access = { caller: vi.fn(async () => ({})) };
    const guard = new MemoryUploadGuard(access as never);
    await expect(guard.canActivate(context({ 'x-workspace-id': 'ws-1', 'content-length': '1024' }))).resolves.toBe(true);
    expect(access.caller).toHaveBeenCalledWith({ userId: 'u1' }, 'ws-1', 'editor');
    await expect(guard.canActivate(context({}))).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(guard.canActivate(context({ 'content-length': String(MAX_UPLOAD_REQUEST_BYTES + 1) }))).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('refuses a viewer without reading the length', async () => {
    const access = { caller: vi.fn(async () => { throw new NotFoundException('memory off'); }) };
    await expect(new MemoryUploadGuard(access as never).canActivate(context({ 'content-length': '1' }))).rejects.toBeInstanceOf(NotFoundException);
  });
});
