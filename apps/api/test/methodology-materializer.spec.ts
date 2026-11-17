import { describe, expect, it, vi } from 'vitest';
import { effectiveGlossary, type Blueprint } from '@knowledge/contracts';
import { MethodologyMaterializerService, ownedName } from '../src/blueprints/methodology-materializer.service.js';
import { AiSkillsService } from '../src/ai/ai-skills.service.js';

const WS = 'ws';
const BP = 'b1b2b3b4-0000-4000-8000-000000000000';
const step = { id: 'review', kind: 'review' as const, title: 'Review', next: [], fanOut: false, autoApprove: false };
const methodology = (over: Partial<Blueprint> = {}): Blueprint => ({
  name: { en: 'Method' },
  tree: [],
  levels: [{ key: 'rules', name: { en: 'Rules' }, templateRefs: [] }],
  conventions: {
    templates: [{ name: 'Rule', source: '# Rule\n' }],
    styleguide: { rules: [{ id: 'one-rule', text: 'One invariant per page.', severity: 'warning', enabled: true }] },
    glossary: [{ term: 'Invariant', definition: 'A rule that always holds.' }],
  },
  workflows: [{ name: 'Draft rules', graph: { steps: [step] } }],
  ...over,
});

/** A workspace in memory: the four owned tables plus the services the materializer writes through. */
function setup() {
  const db = {
    templates: [] as Record<string, unknown>[],
    versions: [] as { templateId: string; version: number; source: string }[],
    workflows: [] as Record<string, unknown>[],
    skills: [] as Record<string, unknown>[],
    terms: [] as Record<string, unknown>[],
  };
  let n = 0;
  const id = () => `id-${++n}`;
  const where = (rows: Record<string, unknown>[], w: Record<string, unknown>) => rows.filter((r) => Object.entries(w).every(([k, v]) => r[k] === v));
  const prisma = {
    withTransaction: async <T>(fn: () => Promise<T>) => fn(),
    pageTemplate: { findMany: async ({ where: w }: { where: Record<string, unknown> }) => where(db.templates, w) },
    pageTemplateVersion: {
      findUnique: async ({ where: w }: { where: { templateId_version: { templateId: string; version: number } } }) =>
        db.versions.find((v) => v.templateId === w.templateId_version.templateId && v.version === w.templateId_version.version) ?? null,
    },
    workflowDefinition: { findMany: async ({ where: w }: { where: Record<string, unknown> }) => where(db.workflows, w) },
    aiSkill: {
      findFirst: async ({ where: w }: { where: Record<string, unknown> }) => where(db.skills, w)[0] ?? null,
      update: vi.fn(async ({ where: w, data }: { where: { id: string }; data: object }) => Object.assign(db.skills.find((r) => r.id === w.id)!, data)),
    },
    aiAgent: { findMany: async () => [] },
    onCommit: (fn: () => Promise<unknown>) => void fn(),
    glossaryTerm: {
      findMany: async ({ where: w }: { where: Record<string, unknown> }) => where(db.terms, w),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => db.terms.push({ id: id(), enabled: true, ...data })),
      update: vi.fn(async ({ where: w, data }: { where: { id: string }; data: object }) => Object.assign(db.terms.find((r) => r.id === w.id)!, data)),
    },
  };
  const templates = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      const row = { id: id(), workspaceId: input.workspaceId, projectId: null, blueprintId: input.blueprintId, builtInKey: null, name: input.name, description: input.description, icon: input.icon, currentVersion: 1, archivedAt: null };
      db.templates.push(row);
      db.versions.push({ templateId: row.id, version: 1, source: input.source as string });
    }),
    update: vi.fn(async (rowId: string, patch: { source?: string; description?: string | null }) => {
      const row = db.templates.find((r) => r.id === rowId)!;
      if (patch.source) {
        row.currentVersion = (row.currentVersion as number) + 1;
        db.versions.push({ templateId: rowId, version: row.currentVersion as number, source: patch.source });
      }
      if (patch.description !== undefined) row.description = patch.description;
    }),
    setArchived: vi.fn(async (rowId: string, archived: boolean) => {
      db.templates.find((r) => r.id === rowId)!.archivedAt = archived ? new Date() : null;
    }),
  };
  const workflows = {
    create: vi.fn(async (dto: Record<string, unknown>) => {
      if (db.workflows.some((w) => w.name === dto.name)) throw new Error('P2002'); // unique (workspace_id, name)
      db.workflows.push({ id: id(), workspaceId: dto.workspaceId, blueprintId: dto.blueprintId, name: dto.name, description: dto.description ?? null, enabled: true, graph: dto.graph, trigger: dto.trigger, version: 1 });
    }),
    update: vi.fn(async (rowId: string, patch: Record<string, unknown>) => {
      const row = db.workflows.find((r) => r.id === rowId)!;
      Object.assign(row, patch, patch.graph ? { version: (row.version as number) + 1 } : {});
    }),
  };
  const skills = {
    upsertStyleguide: vi.fn(async (_ws: string, input: Record<string, unknown>) => {
      const row = db.skills.find((r) => r.blueprintId === input.blueprintId);
      if (row) Object.assign(row, { description: input.description, rules: input.rules });
      else db.skills.push({ id: id(), workspaceId: WS, kind: 'styleguide', projectId: null, enabled: true, ...input });
    }),
  };
  const service = new MethodologyMaterializerService(prisma as never, templates as never, workflows as never, skills as never, { invalidate: vi.fn() } as never);
  return { service, db, templates, workflows };
}

describe('MethodologyMaterializerService (#1124)', () => {
  it('writes each owned row once, and nothing the second time', async () => {
    const { service, db } = setup();
    expect(await service.materialize(WS, BP, methodology())).toBe(4);
    expect(db.templates).toMatchObject([{ name: 'Rule', blueprintId: BP, projectId: null }]);
    expect(db.workflows).toMatchObject([{ name: ownedName('Draft rules', BP), blueprintId: BP }]);
    expect(db.skills).toMatchObject([{ kind: 'styleguide', blueprintId: BP, projectId: null }]);
    expect(db.terms).toMatchObject([{ term: 'Invariant', blueprintId: BP, projectId: null }]);
    // jsonb hands objects back with its own key order: still no change.
    db.workflows[0]!.graph = JSON.parse(JSON.stringify({ steps: [Object.fromEntries(Object.entries(step).reverse())] }));
    expect(await service.materialize(WS, BP, methodology())).toBe(0);
  });

  it('versions a changed template once; archives and disables what a version drops', async () => {
    const { service, db } = setup();
    await service.materialize(WS, BP, methodology());
    const changed = methodology();
    changed.conventions!.templates = [{ name: 'Rule', source: '# Rule\n\n## Given\n' }];
    expect(await service.materialize(WS, BP, changed)).toBe(1);
    expect(db.versions.map((v) => v.version)).toEqual([1, 2]);

    expect(await service.materialize(WS, BP, methodology({ conventions: {}, workflows: [] }))).toBe(4);
    expect(db.templates[0]!.archivedAt).toBeInstanceOf(Date); // archived: a page made from it still resolves
    expect(db.workflows[0]).toMatchObject({ enabled: false }); // disabled, never deleted: its runs stay readable
    expect(db.skills[0]).toMatchObject({ enabled: false });
    expect(db.terms[0]).toMatchObject({ enabled: false });
    // Declared again: brought back, not duplicated.
    expect(await service.materialize(WS, BP, changed)).toBe(4);
    expect([db.templates.length, db.workflows.length, db.skills.length, db.terms.length]).toEqual([1, 1, 1, 1]);
  });

  it('leaves a workspace workflow of the same name alone', async () => {
    const { service, db } = setup();
    db.workflows.push({ id: 'mine', workspaceId: WS, blueprintId: null, name: 'Draft rules', enabled: true, graph: {}, trigger: {} });
    await service.materialize(WS, BP, methodology());
    expect(db.workflows.map((w) => w.name)).toEqual(['Draft rules', ownedName('Draft rules', BP)]);
    expect(db.workflows[0]).toMatchObject({ id: 'mine', blueprintId: null, enabled: true });
  });
});

describe('methodology conventions resolve between project and workspace (#1124)', () => {
  it('styleguide: the project’s own, else its methodology’s enabled one, else the workspace’s', async () => {
    const rows: { id: string; workspaceId: string; kind: string; projectId: string | null; blueprintId: string | null; enabled: boolean; rules: [] }[] = [
      { id: 'ws', workspaceId: WS, kind: 'styleguide', projectId: null, blueprintId: null, enabled: true, rules: [] },
      { id: 'm', workspaceId: WS, kind: 'styleguide', projectId: null, blueprintId: BP, enabled: true, rules: [] },
    ];
    const linked = { blueprintId: BP as string | null };
    const prisma = {
      project: { findUnique: async () => ({ ...linked }) },
      aiSkill: { findMany: async () => rows },
    };
    const skills = new AiSkillsService(prisma as never, { get: () => 0 } as never);
    expect((await skills.effectiveStyleguide(WS, 'p'))?.row.id).toBe('m');
    expect((await skills.effectiveStyleguide(WS, 'p'))?.scope).toBe('methodology');
    expect((await skills.effectiveStyleguide(WS, null))?.row.id).toBe('ws');
    rows[1]!.enabled = false;
    expect((await skills.effectiveStyleguide(WS, 'p'))?.row.id).toBe('ws');
    linked.blueprintId = null;
    rows[1]!.enabled = true;
    expect((await skills.effectiveStyleguide(WS, 'p'))?.scope).toBe('workspace');
    rows.push({ id: 'own', workspaceId: WS, kind: 'styleguide', projectId: 'p', blueprintId: null, enabled: true, rules: [] });
    linked.blueprintId = BP;
    expect((await skills.effectiveStyleguide(WS, 'p'))?.scope).toBe('project');
  });

  it('glossary: a project term replaces its methodology’s, which replaces the workspace’s', () => {
    const term = (id: string, term: string, projectId: string | null, blueprintId: string | null) => ({ id, term, aliases: [], projectId, blueprintId });
    const terms = [term('w1', 'Invariant', null, null), term('w2', 'Order', null, null), term('m1', 'invariant', null, BP), term('m2', 'Order', null, BP), term('p1', 'ORDER', 'p', null)];
    expect(effectiveGlossary(terms, 'p').map((t) => t.id)).toEqual(['p1', 'm1']);
    // No methodology terms handed in: exactly the two-level answer.
    expect(effectiveGlossary(terms.filter((t) => !t.blueprintId), 'p').map((t) => t.id)).toEqual(['p1', 'w1']);
  });
});
