import { describe, expect, it, vi } from 'vitest';
import { nextChildTitle } from '@knowledge/contracts';
import { deriveTree, headingsOf, titleLocale, type SourcePage } from '../src/blueprints/derive-rules.js';
import { parseBlueprint } from '../src/blueprints/blueprint.schema.js';
import { BlueprintsService } from '../src/blueprints/blueprints.service.js';
import { BlueprintDeriveService } from '../src/blueprints/blueprint-derive.service.js';

const leaf = (title: string, headings: string[] = [], templateRef: string | null = null): SourcePage => ({
  title,
  category: 'other',
  templateRef,
  headings,
  children: [],
});
const parent = (title: string, children: SourcePage[], extra: Partial<SourcePage> = {}): SourcePage => ({
  ...leaf(title),
  children,
  ...extra,
});

describe('derive rules (#716)', () => {
  it('reads h2–h4 headings outside code fences, never the body', () => {
    const md = '# Title\n\nSecret body text.\n\n## Context\n\n```\n## not a heading\n```\n\n### Options ##\n\n##### too deep\n';
    expect(headingsOf(md)).toEqual(['## Context', '### Options']);
  });

  it('tells the two locales apart by script', () => {
    expect(titleLocale('Решения')).toBe('ru');
    expect(titleLocale('Decisions')).toBe('en');
  });

  it('folds numbered ADR leaves into a collection whose pattern numbers the next one', () => {
    const adrs = Array.from({ length: 19 }, (_, i) => leaf(`ADR ${String(i + 1).padStart(4, '0')}: Decision ${i}`, [], 'builtin:adr'));
    const [decisions] = deriveTree([parent('Decisions', [...adrs, leaf('How we decide')])]);
    expect(decisions!.collection).toEqual({ childTemplateRef: 'builtin:adr', childTitlePattern: { en: 'ADR {{n:4}}: ' } });
    // Leaves become the rule, never copies; the odd one out stays a page.
    expect(decisions!.children?.map((c) => c.title.en)).toEqual(['How we decide']);
    expect(nextChildTitle('ADR {{n:4}}: ', adrs.map((a) => a.title))).toBe('ADR 0020: ');
  });

  it('pads only when the source did, across 01…12', () => {
    const chapters = Array.from({ length: 12 }, (_, i) => leaf(`${String(i + 1).padStart(2, '0')} — Глава`));
    const [root] = deriveTree([parent('Ресерч', chapters)]);
    expect(root!.collection?.childTitlePattern).toEqual({ ru: '{{n:2}} — ' });
  });

  it('folds three same-shaped leaves; two, or a minority, stay pages', () => {
    const shape = ['## Steps', '## Result'];
    const [three] = deriveTree([parent('Guides', [leaf('a', shape), leaf('b', shape), leaf('c', shape)])]);
    expect(three!.collection).toEqual({});
    expect(three!.children).toBeUndefined();
    const [two] = deriveTree([parent('Guides', [leaf('a', shape), leaf('b', shape), leaf('c'), leaf('d'), leaf('e')])]);
    expect(two!.collection).toBeUndefined();
    expect(two!.children).toHaveLength(5);
  });

  it('keeps a built-in template as the template and other skeletons as the body', () => {
    const [a, b, c] = deriveTree([leaf('API', ['## Endpoints'], 'builtin:api-spec'), { ...leaf('Vision', ['## Audience', '## Goals']), category: 'guide' }, { ...leaf('Odd'), category: 'Runbooks' }]);
    expect(a).toEqual({ title: { en: 'API' }, templateRef: 'builtin:api-spec' });
    expect(b).toEqual({ title: { en: 'Vision' }, category: 'guide', body: { en: '## Audience\n\n## Goals' } });
    expect(c).toEqual({ title: { en: 'Odd' } });
  });

  it('drops a custom template ref: its id means nothing in another project', () => {
    const [a] = deriveTree([leaf('Page', [], '6f1c1e0a-1111-4111-8111-111111111111')]);
    expect(a!.templateRef).toBeUndefined();
  });

  it('yields a tree the one schema accepts, capped at the page limit', () => {
    const wide = Array.from({ length: 300 }, (_, i) => parent(`Section ${i} notes`, [leaf(`child of ${i}`)]));
    const tree = deriveTree(wide);
    const count = (nodes: typeof tree): number => nodes.reduce((n, c) => n + 1 + count(c.children ?? []), 0);
    expect(count(tree)).toBeLessThanOrEqual(200);
    expect(() => parseBlueprint({ name: { en: 'x' }, tree })).not.toThrow();
  });
});

describe('BlueprintsService (#716, phase 4)', () => {
  type Row = { id: string; workspaceId: string; builtInKey: string | null; enabled: boolean; currentVersion: number; versions: { version: number; blueprint: unknown }[] };
  function setup(rows: Row[]) {
    const matches = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (r as never)[k] === v);
    const prisma = {
      projectBlueprint: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where))),
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { versions?: { create: Row['versions'][number] } } & Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          return { ...row, ...data, versions: data.versions ? [data.versions.create] : row.versions };
        }),
      },
    };
    return { service: new BlueprintsService(prisma as never), prisma };
  }
  const saved = { name: { en: 'Ours' }, tree: [{ title: { en: 'Home' } }] };
  const SAVED_ID = '6f1c1e0a-1111-4111-8111-111111111111';

  it('lists built-ins first, hides a disabled one unless asked, and serves an override’s content', async () => {
    const { service } = setup([
      { id: 'o1', workspaceId: 'ws', builtInKey: 'discovery', enabled: false, currentVersion: 0, versions: [] },
      { id: 'o2', workspaceId: 'ws', builtInKey: 'blank', enabled: true, currentVersion: 2, versions: [{ version: 2, blueprint: saved }] },
      { id: SAVED_ID, workspaceId: 'ws', builtInKey: null, enabled: true, currentVersion: 1, versions: [{ version: 1, blueprint: saved }] },
    ]);
    const { blueprints } = await service.list('ws');
    expect(blueprints.map((b) => b.key)).toEqual(['code-product', 'service-docs', 'blank', SAVED_ID]);
    expect(blueprints[2]).toMatchObject({ builtIn: true, id: 'o2', version: 2, blueprint: saved });
    expect((await service.list('ws', true)).blueprints[0]).toMatchObject({ key: 'discovery', enabled: false });

    await expect(service.resolve('ws', 'discovery')).rejects.toThrow(/notFound/);
    expect(await service.resolve('ws', 'blank')).toEqual(saved);
    expect(await service.resolve('ws', SAVED_ID)).toEqual(saved);
    await expect(service.resolve('ws', 'not-a-key')).rejects.toThrow(/notFound/);
  });

  it('appends a version only when the content changed', async () => {
    // As jsonb hands it back: same content, keys in its own order.
    const stored = { tree: saved.tree, name: saved.name };
    const { service, prisma } = setup([
      { id: SAVED_ID, workspaceId: 'ws', builtInKey: null, enabled: true, currentVersion: 1, versions: [{ version: 1, blueprint: stored }] },
    ]);
    await service.update(SAVED_ID, { blueprint: saved, enabled: false }, 'u1');
    expect(prisma.projectBlueprint.update.mock.calls[0]![0].data).toEqual({ enabled: false });
    await service.update(SAVED_ID, { blueprint: { ...saved, tree: [] } }, 'u1');
    expect(prisma.projectBlueprint.update.mock.calls[1]![0].data).toMatchObject({ currentVersion: 2, versions: { create: { version: 2 } } });
  });
});

describe('BlueprintDeriveService (#716, phase 4)', () => {
  const tree = [
    { documentId: 'd1', title: 'Decisions', category: 'other', headRevisionId: null, headRevisionStatus: null, draftOwnerId: null, children: [] },
    { documentId: 'd2', title: 'Someone’s draft', category: 'other', headRevisionId: null, headRevisionStatus: null, draftOwnerId: 'u2', children: [] },
  ];
  function setup(opts: { sourceWorkspace: string; assistantOff?: boolean; reply?: string }) {
    const prisma = {
      project: { findUnique: vi.fn(async () => ({ id: 'p', workspaceId: opts.sourceWorkspace, name: 'Watchdog', description: null, avatarEmoji: null })) },
      document: { findMany: vi.fn(async () => [{ id: 'd1', templateRef: null }]) },
      pageTemplate: { findMany: vi.fn(async () => []) },
      glossaryTerm: { findMany: vi.fn(async () => [{ term: 'Probe', definition: 'A check', aliases: [] }]) },
    };
    const permissions = { requireResource: vi.fn(async () => undefined), scopeFor: vi.fn(async () => ({})) };
    const documents = { getTree: vi.fn(async () => ({ roots: tree })) };
    const features = { disabled: vi.fn(async () => (opts.assistantOff ? ['assistant'] : [])) };
    const agents = { resolve: vi.fn(async () => ({ enabled: true, instructions: 'x', config: { enabled: true } })) };
    const client = { chat: vi.fn(async () => opts.reply ?? '{}') };
    const service = new BlueprintDeriveService(
      prisma as never,
      permissions as never,
      documents as never,
      features as never,
      agents as never,
      { assertWithinBudget: vi.fn(async () => undefined) } as never,
      client as never,
    );
    return { service, prisma, permissions, client };
  }
  const principal = { userId: 'u1', locale: 'en' } as never;

  it('checks the project in its own workspace and offers glossary only from the same one', async () => {
    const other = setup({ sourceWorkspace: 'ws-b', assistantOff: true });
    const res = await other.service.derive('ws-a', 'p', principal);
    expect(other.permissions.requireResource).toHaveBeenCalledWith(principal, 'ws-b', { type: 'project', id: 'p' }, 'viewer', false);
    expect(res.glossary).toEqual([]);
    expect(res.blueprint.tree.map((n) => n.title.en)).toEqual(['Decisions']); // a draft is not structure
    expect(other.client.chat).not.toHaveBeenCalled();
    expect(res.drafted).toBe(false);
    // Another workspace's own templates travel too.
    expect(JSON.stringify(other.prisma.pageTemplate.findMany.mock.calls[0])).toContain('"projectId":null');

    const same = setup({ sourceWorkspace: 'ws-a', assistantOff: true });
    expect((await same.service.derive('ws-a', 'p', principal)).glossary).toEqual([{ term: 'Probe', definition: 'A check' }]);
    expect(JSON.stringify(same.prisma.pageTemplate.findMany.mock.calls[0])).not.toContain('"projectId":null');
  });

  it('takes only what it asked for from the scaffolder', async () => {
    const reply = JSON.stringify({
      styleguide: { description: 'How we write', rules: [{ text: 'Number every decision', severity: 'shout' }, { text: '' }] },
      guidance: { n1: 'One decision per page.', n9: 'ghost', '__proto__': 'x' },
    });
    const { service, client } = setup({ sourceWorkspace: 'ws-a', reply });
    const res = await service.derive('ws-a', 'p', principal);
    expect(String((client.chat.mock.calls[0] as unknown as [unknown, { content: string }[]])[1][1]!.content)).toMatch(/untrusted|<pages/i);
    expect(res.drafted).toBe(true);
    expect(res.blueprint.tree[0]!.guidance).toEqual({ en: 'One decision per page.' });
    expect(res.blueprint.conventions?.styleguide).toEqual({
      description: 'How we write',
      rules: [{ id: 'rule-1', text: 'Number every decision', severity: 'warning', enabled: true }],
    });
  });

  it('falls back to the rules when the call fails', async () => {
    const { service, client } = setup({ sourceWorkspace: 'ws-a' });
    client.chat.mockRejectedValueOnce(new Error('provider down'));
    const res = await service.derive('ws-a', 'p', principal);
    expect(res.drafted).toBe(false);
    expect(res.blueprint.conventions).toBeUndefined();
  });
});
