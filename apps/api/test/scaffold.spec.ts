import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_BLUEPRINT_KEYS,
  BUILT_IN_TEMPLATE_KEYS,
  nextChildTitle,
  parseTemplateRef,
  type Blueprint,
  type BlueprintNode,
} from '@knowledge/contracts';
import { isScaffoldStub, scaffoldStubSql, SCAFFOLD_ORIGIN } from '../src/common/scaffold-stub.js';
import { parseBlueprint } from '../src/blueprints/blueprint.schema.js';
import { BUILT_IN_BLUEPRINTS } from '../src/blueprints/built-in/index.js';
import { BUILT_IN_TEMPLATES } from '../src/templates/built-in/index.js';
import { ProjectScaffoldService } from '../src/projects/project-scaffold.service.js';

// #716 phase 1: blueprints, the numbering helper, the stub predicate and the scaffold writer.

describe('nextChildTitle', () => {
  it('numbers past the highest sibling, padded, gaps kept', () => {
    expect(nextChildTitle('ADR {{n:4}}: ', [])).toBe('ADR 0001: ');
    expect(nextChildTitle('ADR {{n:4}}: ', ['ADR 0001: A', 'ADR 0007: B', 'Notes'])).toBe('ADR 0008: ');
    expect(nextChildTitle('{{n:2}} — ', ['01 — Goals', '02 — Scope'], 'Risks')).toBe('03 — Risks');
    expect(nextChildTitle('{{n}}. ', ['9. x', '10. y'])).toBe('11. ');
  });

  it('does not count a number in another position, or another prefix', () => {
    expect(nextChildTitle('ADR {{n:4}}: ', ['RFC 0042: x', 'About ADR 0099: y'])).toBe('ADR 0001: ');
  });

  it('writes today, ISO, for {{date}}', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    expect(nextChildTitle('{{date}} session', [], undefined, now)).toBe('2026-11-02 session');
    expect(nextChildTitle('{{date}} session', [], 'Kickoff', now)).toBe('2026-11-02 session Kickoff');
  });
});

describe('isScaffoldStub and scaffoldStubSql', () => {
  it('is a stub only while the head is the scaffold revision', () => {
    expect(isScaffoldStub({ origin: SCAFFOLD_ORIGIN })).toBe(true);
    expect(isScaffoldStub({ origin: null })).toBe(false);
    expect(isScaffoldStub(null)).toBe(false);
    expect(isScaffoldStub(undefined)).toBe(false);
  });

  // Run against PostgreSQL over the same rows in scaffold-stub.e2e-spec.ts.
  it('asks the same question in SQL: the default-branch head, by the same origin', () => {
    const q = scaffoldStubSql('d');
    expect(q.values).toEqual([SCAFFOLD_ORIGIN]);
    const sql = q.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('stub_r.id = stub_b.head_revision_id');
    expect(sql).toContain('stub_b.document_id = d.id AND stub_b.name = d.default_branch');
    expect(sql).toContain('stub_r.origin = ?');
  });
});

const walk = (nodes: BlueprintNode[]): BlueprintNode[] => nodes.flatMap((n) => [n, ...walk(n.children ?? [])]);

describe('built-in blueprints', () => {
  it('has one per key, each passing the one schema, every title in both languages', () => {
    expect(Object.keys(BUILT_IN_BLUEPRINTS)).toEqual([...BUILT_IN_BLUEPRINT_KEYS]);
    for (const blueprint of Object.values(BUILT_IN_BLUEPRINTS)) {
      expect(parseBlueprint(blueprint)).toEqual(blueprint);
      for (const node of walk(blueprint.tree)) {
        expect(node.title.en && node.title.ru).toBeTruthy();
        for (const ref of [node.templateRef, node.collection?.childTemplateRef].filter(Boolean) as string[]) {
          const parsed = parseTemplateRef(ref);
          expect(parsed?.kind, ref).toBe('builtin');
        }
      }
    }
  });

  it('ships the research-question template in both languages', () => {
    expect(BUILT_IN_TEMPLATE_KEYS).toContain('research-question');
    const tpl = BUILT_IN_TEMPLATES['research-question'];
    for (const heading of ['## Question', '## Options', '## Criteria', '## Findings', '## Decision', '## Open questions']) {
      expect(tpl.text.en.source).toContain(heading);
    }
    expect(tpl.text.ru.source).toContain('## Открытые вопросы');
  });

  it('gives Decisions the ADR rule', () => {
    const decisions = BUILT_IN_BLUEPRINTS['code-product'].tree.find((n) => n.title.en === 'Decisions')!;
    expect(decisions.collection).toEqual({ childTemplateRef: 'builtin:adr', childTitlePattern: { en: 'ADR {{n:4}}: ', ru: 'ADR {{n:4}}: ' } });
  });
});

describe('parseBlueprint', () => {
  const ok: Blueprint = { name: { en: 'X' }, tree: [{ title: { ru: 'Страница' } }] };

  it('accepts one language', () => {
    expect(parseBlueprint(ok)).toEqual(ok);
  });

  it('refuses unknown keys, empty titles, bad refs and oversize trees with a 400', () => {
    const bad = [
      { ...ok, extra: 1 },
      { ...ok, tree: [{ title: { en: ' ' } }] },
      { ...ok, tree: [{ title: { en: 'A' }, templateRef: 'builtin:nope' }] },
      { ...ok, tree: [{ title: { en: 'A' }, category: 'poem' }] },
      { ...ok, tree: Array.from({ length: 201 }, () => ({ title: { en: 'A' } })) },
      { ...ok, tree: [{ title: { en: '1' }, children: [{ title: { en: '2' }, children: [{ title: { en: '3' }, children: [{ title: { en: '4' }, children: [{ title: { en: '5' }, children: [{ title: { en: '6' } }] }] }] }] }] }] },
      { ...ok, conventions: { styleguide: { rules: [{ id: 'Bad Id', text: 'x', severity: 'error', enabled: true }] } } },
    ];
    for (const b of bad) expect(() => parseBlueprint(b)).toThrow(/blueprint\.invalid/);
  });
});

describe('ProjectScaffoldService', () => {
  function setup() {
    let n = 0;
    const created: Array<{ title: string; parentId?: string; template?: { ref: string }; text: string; documentId: string }> = [];
    const prisma = {
      withTransaction: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
      documentRevision: { update: vi.fn(async () => ({})) },
      document: { update: vi.fn(async () => ({})), findFirst: vi.fn() },
      aiSkill: { findUnique: vi.fn(async () => null) },
      glossaryTerm: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const documents = {
      createDocument: vi.fn(async (dto: { title: string; parentId?: string; template?: { ref: string }; content: { text: string } }) => {
        const documentId = `doc-${++n}`;
        created.push({ title: dto.title, parentId: dto.parentId, template: dto.template, text: dto.content.text, documentId });
        return { documentId, revisionId: `rev-${n}`, branch: 'main', status: 'finalized' };
      }),
    };
    const projects = {
      create: vi.fn(async () => ({ project: { projectId: 'p1' } })),
      get: vi.fn(async () => ({ projectId: 'p1', documentCount: 0 })),
    };
    const templates = {
      defaults: vi.fn(async ({ title }: { title: string }) => ({ skeleton: `# ${title}\n\n## Context\n`, frontmatter: {}, tags: ['adr'] })),
      create: vi.fn(async () => ({})),
    };
    const skills = { upsertStyleguide: vi.fn(async () => ({})) };
    const permissions = { scopeFor: vi.fn(async () => ({})), requireCreateUnder: vi.fn(async () => undefined) };
    const service = new ProjectScaffoldService(
      prisma as never,
      projects as never,
      documents as never,
      templates as never,
      skills as never,
      permissions as never,
    );
    return { service, prisma, documents, projects, templates, skills, created };
  }
  const principal = { userId: 'u1' } as never;
  const dto = (over: object = {}) => ({ workspaceId: 'ws', name: 'Watchdog', locale: 'ru' as const, ...over });

  it('writes the built-in tree depth-first, in the chosen language, every page a stamped stub', async () => {
    const { service, prisma, created } = setup();
    const blueprint = service.resolve({ blueprintKey: 'code-product' });
    const res = await service.scaffold(dto({ blueprintKey: 'code-product' }) as never, blueprint, principal);
    const total = walk(blueprint.tree).length;
    expect(res.pageCount).toBe(total);
    expect(created.map((c) => c.title).slice(0, 3)).toEqual(['Продукт', 'Видение и аудитория', 'Бриф']);
    expect(created[1]!.parentId).toBe(created[0]!.documentId);
    expect(prisma.documentRevision.update).toHaveBeenCalledTimes(total);
    expect(prisma.documentRevision.update).toHaveBeenCalledWith({ where: { id: 'rev-1' }, data: { origin: SCAFFOLD_ORIGIN } });
    expect(prisma.withTransaction).toHaveBeenCalledOnce();
    const decisions = created.find((c) => c.title === 'Решения')!;
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: decisions.documentId },
      data: { childTemplateRef: 'builtin:adr', childTitlePattern: 'ADR {{n:4}}: ' },
    });
    expect(created[0]!.text).toContain('> [!NOTE]');
  });

  it('numbers and shapes a collection’s initial items by its rule', async () => {
    const { service, created } = setup();
    const blueprint: Blueprint = {
      name: { en: 'X' },
      tree: [
        {
          title: { en: 'Decisions' },
          collection: { childTemplateRef: 'builtin:adr', childTitlePattern: { en: 'ADR {{n:4}}: ' } },
          children: [{ title: { en: 'Use Postgres' } }, { title: { en: 'Use Redis' } }],
        },
      ],
    };
    await service.scaffold(dto({ locale: 'en', blueprint }) as never, service.resolve({ blueprint } as never), principal);
    expect(created.map((c) => c.title)).toEqual(['Decisions', 'ADR 0001: Use Postgres', 'ADR 0002: Use Redis']);
    expect(created[1]!.template).toEqual({ ref: 'builtin:adr' });
    expect(created[1]!.text).toContain('tags:');
  });

  it('writes conventions only for a new project', async () => {
    const blueprint: Blueprint = {
      name: { en: 'X' },
      tree: [],
      conventions: {
        styleguide: { rules: [{ id: 'active-voice', text: 'Use the active voice', severity: 'warning', enabled: true }] },
        templates: [{ name: 'Session', source: '---\ntemplate:\n  category: other\n---\n# {{title}}\n' }],
        glossary: [{ term: 'Probe', definition: 'A check' }, { term: 'probe', definition: 'dupe' }],
      },
    };
    const fresh = setup();
    await fresh.service.scaffold(dto({ blueprint }) as never, blueprint, principal);
    expect(fresh.skills.upsertStyleguide).toHaveBeenCalledWith('ws', expect.objectContaining({ projectId: 'p1', name: 'Watchdog' }), 'u1');
    expect(fresh.templates.create).toHaveBeenCalledOnce();
    expect((fresh.prisma.glossaryTerm.createMany.mock.calls[0] as unknown as [{ data: unknown[] }])[0].data).toHaveLength(1);

    const under = setup();
    under.prisma.document.findFirst.mockResolvedValue({ id: 'parent', projectId: 'p9' });
    await under.service.scaffold(dto({ blueprint, parentId: 'parent' }) as never, blueprint, principal);
    expect(under.projects.create).not.toHaveBeenCalled();
    expect(under.skills.upsertStyleguide).not.toHaveBeenCalled();
    expect(under.templates.create).not.toHaveBeenCalled();
  });

  it('wants exactly one of a key and a blueprint', () => {
    const { service } = setup();
    expect(() => service.resolve({})).toThrow(/oneSource/);
    expect(() => service.resolve({ blueprintKey: 'blank', blueprint: {} })).toThrow(/oneSource/);
  });

  it('propagates a failure out of the transaction, so nothing commits', async () => {
    const { service, documents } = setup();
    documents.createDocument.mockRejectedValueOnce(new Error('storage down'));
    await expect(
      service.scaffold(dto({ blueprintKey: 'discovery' }) as never, service.resolve({ blueprintKey: 'discovery' }), principal),
    ).rejects.toThrow('storage down');
  });
});

describe('POST /v1/projects/scaffold', () => {
  it('needs an admin only when the blueprint carries a styleguide for a new project', async () => {
    const { ProjectsController } = await import('../src/projects/projects.controller.js');
    const styleguide = { rules: [{ id: 'r', text: 'Be brief', severity: 'warning' as const, enabled: true }] };
    const scaffolder = {
      resolve: vi.fn((dto: { blueprint?: Blueprint }) => dto.blueprint ?? { name: { en: 'B' }, tree: [] }),
      scaffold: vi.fn(async () => ({})),
    };
    const access = { requireRole: vi.fn(async () => undefined) };
    const s = {} as never;
    const controller = new ProjectsController(s, s, s, scaffolder as never, s, access as never, s);
    const principal = { userId: 'u1' } as never;
    const base = { workspaceId: 'ws', name: 'P', locale: 'en' as const };

    await controller.scaffold({ ...base, blueprintKey: 'code-product' }, principal);
    await controller.scaffold({ ...base, blueprint: { name: { en: 'B' }, tree: [], conventions: { styleguide } } as never, parentId: 'x' }, principal);
    expect(access.requireRole).not.toHaveBeenCalled();

    await controller.scaffold({ ...base, blueprint: { name: { en: 'B' }, tree: [], conventions: { styleguide } } as never }, principal);
    expect(access.requireRole).toHaveBeenCalledWith(principal, 'ws', 'admin');
  });
});
