import { describe, expect, it, vi } from 'vitest';
import type { Blueprint } from '@knowledge/contracts';
import { missingSections } from '../src/projects/methodology-preview.js';
import { ProjectMethodologyService } from '../src/projects/project-methodology.service.js';
import { BlueprintsService } from '../src/blueprints/blueprints.service.js';
import { ProjectScaffoldService } from '../src/projects/project-scaffold.service.js';

const METHOD: Blueprint = {
  name: { en: 'Method' },
  tree: [
    { title: { en: 'Intent', ru: 'Замысел' } },
    { title: { en: 'Rules' }, children: [{ title: { en: 'Billing' } }, { title: { en: 'Access' }, children: [{ title: { en: 'Roles' } }] }] },
    { title: { en: 'Decisions' }, collection: { childTitlePattern: { en: 'ADR {{n:4}}: ' } }, children: [{ title: { en: 'First' } }] },
  ],
  levels: [{ key: 'rules', name: { en: 'Rules' }, templateRefs: ['builtin:adr'] }],
};

describe('missingSections (#1125)', () => {
  it('offers what the project lacks by title, top level and one down, never a collection’s items', () => {
    const pages = [
      { id: 'r', title: ' rules ', parentId: null },
      { id: 'b', title: 'Billing', parentId: 'r' },
      { id: 'd', title: 'Decisions', parentId: null },
    ];
    const out = missingSections(pages, METHOD.tree, 'en');
    expect(out.map(({ id, title, parentTitle, pages: n, parentId }) => ({ id, title, parentTitle, pages: n, parentId }))).toEqual([
      { id: '0', title: 'Intent', parentTitle: null, pages: 1, parentId: null },
      { id: '1.1', title: 'Access', parentTitle: ' rules ', pages: 2, parentId: 'r' },
    ]);
    expect(missingSections([], METHOD.tree, 'ru')[0]!.title).toBe('Замысел');
  });
});

describe('ProjectMethodologyService (#1125)', () => {
  function setup() {
    const project = { workspaceId: 'ws', blueprintId: null as string | null };
    const prisma = {
      withTransaction: async <T>(fn: () => Promise<T>) => fn(),
      project: {
        findUnique: vi.fn(async () => ({ ...project })),
        update: vi.fn(async ({ data }: { data: { blueprintId: string | null } }) => Object.assign(project, data)),
      },
      document: {
        findMany: vi.fn(async () => [{ id: 'r', title: 'Rules', parentId: null }]),
        groupBy: vi.fn(async () => [{ templateRef: 'builtin:adr', _count: { _all: 3 } }, { templateRef: 'builtin:rfc', _count: { _all: 1 } }]),
      },
    };
    const blueprints = {
      resolve: vi.fn(async () => METHOD),
      rowFor: vi.fn(async () => ({ id: 'row-1', blueprint: METHOD })),
      linked: vi.fn(async (id: string) => ({ key: 'kdc', builtIn: true, id, enabled: true, version: 0, blueprint: METHOD })),
    };
    const materializer = { materialize: vi.fn(async () => 0) };
    const scaffold = { writeSections: vi.fn(async () => 1) };
    const permissions = { scopeFor: vi.fn(async () => ({ bypass: true })), requireCreateUnder: vi.fn(async () => undefined) };
    const service = new ProjectMethodologyService(prisma as never, blueprints as never, materializer as never, scaffold as never, permissions as never);
    return { service, project, prisma, blueprints, materializer, scaffold, permissions };
  }
  const principal = { userId: 'u1' } as never;

  it('links without copying, creates only the confirmed sections, and unlinks to nothing', async () => {
    const { service, project, materializer, scaffold, permissions } = setup();
    const linked = await service.set('p', { blueprintKey: 'kdc', sections: ['0', '1.0'], locale: 'en' }, principal);
    expect(materializer.materialize).toHaveBeenCalledWith('ws', 'row-1', METHOD, 'u1');
    expect(project.blueprintId).toBe('row-1');
    expect(linked.methodology).toMatchObject({ key: 'kdc', levels: METHOD.levels });
    expect(permissions.requireCreateUnder).toHaveBeenCalledWith(expect.anything(), { projectId: 'p', parentId: 'r' });
    const [, sections] = scaffold.writeSections.mock.calls[0] as unknown as [unknown, { id: string; parentId: string | null }[]];
    expect(sections.map((s) => [s.id, s.parentId])).toEqual([['0', null], ['1.0', 'r']]);

    expect((await service.set('p', { blueprintKey: null }, principal)).methodology).toBeNull();
    expect(project.blueprintId).toBeNull();
  });

  it('refuses a section the preview would not offer', async () => {
    const { service } = setup();
    await expect(service.set('p', { blueprintKey: 'kdc', sections: ['1'] }, principal)).rejects.toThrow(/unknownSection/);
  });

  it('previews sections and the pages each level would count', async () => {
    const { service } = setup();
    const res = await service.preview('p', 'kdc', principal, 'en');
    expect(res.sections.map((s) => s.id)).toEqual(['0', '1.0', '1.1', '2']);
    expect(res.levels).toEqual([{ key: 'rules', name: 'Rules', pages: 3 }]);
  });

  it('names the agent a turn at each level runs: owned for the methodology’s, itself for a built-in (#1266)', async () => {
    const { service, prisma } = setup();
    const rowId = 'be27393b-0000-4000-8000-000000000000';
    const levels = [
      { key: 'rules', name: { en: 'Rules' }, templateRefs: ['builtin:adr'], agentKey: 'modeller' },
      { key: 'ask', name: { en: 'Ask' }, templateRefs: ['builtin:rfc'], agentKey: 'researcher' },
      { key: 'code', name: { en: 'Code' }, templateRefs: [] },
    ];
    Object.assign(prisma.project, {
      findUnique: vi.fn(async () => ({ workspaceId: 'ws', blueprintId: rowId })),
      findMany: vi.fn(async () => [{ id: 'p', blueprintId: rowId }]),
    });
    Object.assign(prisma, {
      projectBlueprint: { findMany: vi.fn(async () => [{ id: rowId, builtInKey: null, versions: [{ blueprint: { ...METHOD, levels } }] }]) },
    });
    const res = await service.levels('p', principal, 'en');
    expect(res.levels.map((l) => [l.agentKey, l.agent])).toEqual([
      ['modeller', 'modeller-be27393b'],
      ['researcher', 'researcher'],
      [null, null],
    ]);
  });
});

describe('a linked blueprint (#1125)', () => {
  it('is refused deletion while a project links it', async () => {
    const prisma = { project: { count: vi.fn(async () => 2) }, projectBlueprint: { deleteMany: vi.fn() } };
    const service = new BlueprintsService(prisma as never, {} as never);
    await expect(service.remove('row-1')).rejects.toMatchObject({ response: { reason: 'blueprint-in-use', projects: 2 } });
    expect(prisma.projectBlueprint.deleteMany).not.toHaveBeenCalled();
  });

  it('is what scaffolding from a methodology links; plain blueprints and pages under a parent link nothing', async () => {
    const resolve = vi.fn(async (_ws: string, key: string) => (key === 'kdc' ? METHOD : { name: { en: 'Plain' }, tree: [] }));
    const service = new ProjectScaffoldService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { resolve } as never, {} as never);
    expect(await service.methodologyFor({ workspaceId: 'ws', blueprintKey: 'kdc' })).toBe('kdc');
    expect(await service.methodologyFor({ workspaceId: 'ws', methodologyKey: 'kdc' })).toBe('kdc');
    expect(await service.methodologyFor({ workspaceId: 'ws', blueprintKey: 'plain' })).toBeNull();
    expect(await service.methodologyFor({ workspaceId: 'ws', blueprintKey: 'kdc', parentId: 'page' })).toBeNull();
  });
});
