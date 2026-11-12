import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { effectiveGlossary } from '@knowledge/contracts';
import { GlossaryService } from '../src/glossary/glossary.service.js';
import { GlossaryController } from '../src/glossary/glossary.controller.js';

/**
 * Workspace-level glossary terms (#926): a term with no project links in every
 * project, a project's term of the same name replaces it there, two workspace
 * terms never share a name, and only an admin writes or promotes one.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOPE = { workspaceId: WS, userId: 'u', role: 'admin', bypass: true, guest: false, readOnly: false, groupIds: new Set(), denied: new Set(), granted: new Set() } as never;

const term = (id: string, projectId: string | null, name: string, aliases: string[] = []) => ({ id, projectId, term: name, aliases });

describe('effectiveGlossary', () => {
  const sla = term('w-sla', null, 'SLA', ['Service level agreement']);
  const tenant = term('w-tenant', null, 'Tenant');

  it('links a workspace term on the pages of every project', () => {
    const terms = [sla, tenant, term('a-ledger', A, 'Ledger')];
    expect(effectiveGlossary(terms, A).map((t) => t.id)).toEqual(['a-ledger', 'w-sla', 'w-tenant']);
    expect(effectiveGlossary(terms, B).map((t) => t.id)).toEqual(['w-sla', 'w-tenant']);
  });

  it("lets a project's term of the same name win on that project's pages only", () => {
    const terms = [sla, tenant, term('a-tenant', A, 'tenant')];
    expect(effectiveGlossary(terms, A).map((t) => t.id)).toEqual(['a-tenant', 'w-sla']);
    expect(effectiveGlossary(terms, B).map((t) => t.id)).toEqual(['w-sla', 'w-tenant']);
  });

  it('replaces the workspace term whole when the clash is on an alias, either way round', () => {
    expect(effectiveGlossary([sla, term('a-sla', A, 'Service Level Agreement')], A).map((t) => t.id)).toEqual(['a-sla']);
    expect(effectiveGlossary([tenant, term('a-org', A, 'Organisation', ['Tenant'])], A).map((t) => t.id)).toEqual(['a-org']);
  });

  it("is the project's own roster, untouched, while the workspace has no terms", () => {
    const own = [term('a-1', A, 'Ledger'), term('a-2', A, 'Posting')];
    expect(effectiveGlossary([...own, term('b-1', B, 'Ledger')], A)).toEqual(own);
  });
});

function harness(seed: Array<Record<string, unknown>>) {
  const rows = seed.map((r) => ({ workspaceId: WS, aliases: [], definition: 'd', documentId: null, source: 'manual', createdAt: new Date(), updatedAt: new Date(), ...r }));
  const find = (where: Record<string, unknown>) =>
    rows.filter((r) => {
      const { term: name, ...rest } = where as { term?: { equals: string } };
      const same = Object.entries(rest).every(([key, value]) => (r as Record<string, unknown>)[key] === value);
      return same && (!name || String(r.term).toLowerCase() === name.equals.toLowerCase());
    });
  const prisma = {
    withTransaction: <T>(fn: () => Promise<T>) => fn(),
    $executeRaw: vi.fn(async () => 1),
    glossaryTerm: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => find(where)[0] ?? null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `new-${rows.length}`, createdAt: new Date(), updatedAt: new Date(), ...data } as (typeof rows)[number];
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = find(where);
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => rows.splice(rows.findIndex((r) => r.id === where.id), 1)),
    },
    glossaryExclusion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  const projects = { requireProjectInWorkspace: vi.fn(async () => undefined) };
  const activity = { record: vi.fn(async () => undefined) };
  const svc = new GlossaryService(prisma as never, activity as never, {} as never, projects as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, rows, prisma };
}

describe('GlossaryService with workspace terms', () => {
  const create = (svc: GlossaryService, projectId: string | null, name: string) =>
    svc.create({ workspaceId: WS, projectId, term: name, definition: 'd' }, SCOPE, 'u');

  it('never holds two workspace terms of one name, while a project may define the same word', async () => {
    const { svc } = harness([{ id: 'w', projectId: null, term: 'Tenant' }]);
    await expect(create(svc, null, 'tenant')).rejects.toBeInstanceOf(ConflictException);
    expect((await create(svc, A, 'Tenant')).projectId).toBe(A);
    expect((await create(svc, null, 'Ledger')).projectId).toBeNull();
  });

  it('refuses to promote onto an existing workspace term, and replaces it only when told to', async () => {
    const { svc, rows, prisma } = harness([
      { id: 'w', projectId: null, term: 'Tenant' },
      { id: 'a', projectId: A, term: 'tenant' },
    ]);
    const refused = await svc.promote('a', undefined, SCOPE, 'u').catch((e) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect(refused.getResponse()).toMatchObject({ reason: 'workspace-term-exists', termId: 'w' });
    expect(rows.map((r) => [r.id, r.projectId])).toEqual([['w', null], ['a', A]]);

    expect((await svc.promote('a', 'replace', SCOPE, 'u')).projectId).toBeNull();
    expect(rows.map((r) => [r.id, r.projectId])).toEqual([['a', null]]);
    expect(prisma.glossaryExclusion.deleteMany).toHaveBeenCalledWith({ where: { termId: 'w' } });
  });

  it('promotes the same row, so its id and its exclusions survive', async () => {
    const { svc, rows, prisma } = harness([{ id: 'a', projectId: A, term: 'Ledger' }]);
    expect(await svc.promote('a', undefined, SCOPE, 'u')).toMatchObject({ termId: 'a', projectId: null });
    expect(rows).toHaveLength(1);
    expect(prisma.glossaryExclusion.deleteMany).not.toHaveBeenCalled();
  });
});

describe('GlossaryController: who writes a workspace term', () => {
  function controller(workspaceTerm: boolean) {
    const glossary = {
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ deleted: true })),
      isWorkspaceTerm: vi.fn(async () => workspaceTerm),
    };
    const access = { requireRole: vi.fn(async () => undefined), workspaceOf: vi.fn(async () => WS) };
    const permissions = { scopeFor: vi.fn(async () => SCOPE) };
    return { ctrl: new GlossaryController(glossary as never, access as never, permissions as never), access, glossary };
  }
  const editor = { userId: 'u' } as never;

  it('asks for a workspace admin to create, change or remove a workspace term', async () => {
    const { ctrl, access } = controller(true);
    await ctrl.create({ workspaceId: WS, term: 'Tenant', definition: 'd' } as never, editor);
    await ctrl.update('t', {} as never, editor);
    await ctrl.remove('t', editor);
    expect(access.requireRole.mock.calls).toEqual([[editor, WS, 'admin'], [editor, WS, 'admin'], [editor, WS, 'admin']]);
  });

  it("leaves a project's term to editors, as before", async () => {
    const { ctrl, access, glossary } = controller(false);
    await ctrl.create({ workspaceId: WS, projectId: A, term: 'Ledger', definition: 'd' } as never, editor);
    await ctrl.update('t', {} as never, editor);
    await ctrl.remove('t', editor);
    expect(access.requireRole).not.toHaveBeenCalled();
    expect(glossary.create.mock.calls[0]![0]).toMatchObject({ projectId: A });
  });
});
