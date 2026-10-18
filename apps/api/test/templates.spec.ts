import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_TEMPLATE_KEYS,
  composeTemplateSource,
  detectPlaceholders,
  missingRequiredPlaceholders,
  parseTemplateRef,
  renderTemplate,
  renderTemplateFrontmatter,
  renderTemplateTitle,
  type TemplateMeta,
} from '@knowledge/contracts';
import { parseTemplateSource, TemplateSourceError } from '../src/templates/template-source.js';
import { BUILT_IN_TEMPLATES } from '../src/templates/built-in/index.js';
import { TemplatesService } from '../src/templates/templates.service.js';
import { TemplatesController } from '../src/templates/templates.controller.js';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { withLocale } from '../src/i18n/t.js';
import type { Principal } from '../src/auth/principal.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * Page templates (issue #69, phases 1–2).
 *
 * What is pinned here is what a green UI would hide:
 *
 * 1. **Substitution is narrow.** Only declared and system names are filled in;
 *    `{{baseUrl}}` in an API spec and an escaped `\{{x}}` survive literally,
 *    and a user or page id renders through code, never as caller text.
 * 2. **A template the graph would refuse is refused on save.** Every built-in
 *    parses in both languages, and a bad relation fails the write rather than
 *    the page created from it months later.
 * 3. **Built-ins are code, rows are overrides.** An empty table is exactly the
 *    seven built-ins; hiding, customising and resetting are row operations.
 * 4. **Scope decides the role, and the row decides the workspace.**
 */

const WS = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const PAGE = '55555555-5555-4555-8555-555555555555';

const meta: TemplateMeta = {
  category: 'architecture',
  titlePattern: 'ADR-{{number}}: {{title}}',
  placeholders: [
    { name: 'number', kind: 'text', required: true },
    { name: 'component', kind: 'entity' },
    { name: 'owner', kind: 'user' },
    { name: 'related', kind: 'page' },
    { name: 'when', kind: 'date' },
  ],
};
const ctx = { locale: 'en' as const, title: 'Use Postgres', now: '2026-10-12T10:00:00Z', author: 'Ada' };

describe('render (contracts)', () => {
  it('fills system and declared placeholders and leaves undeclared and escaped ones literal', () => {
    const body = '# {{title}}\n{{ number }} by {{author}} on {{date}}\n{{baseUrl}}/x and \\{{number}}';
    expect(renderTemplate(body, meta, { number: '0042' }, ctx)).toBe(
      '# Use Postgres\n0042 by Ada on 12 Oct 2026\n{{baseUrl}}/x and {{number}}',
    );
  });

  it('renders the title pattern, and falls back to the title as typed', () => {
    expect(renderTemplateTitle(meta, { number: '7' }, ctx)).toBe('ADR-7: Use Postgres');
    expect(renderTemplateTitle({ ...meta, titlePattern: undefined }, {}, ctx)).toBe('Use Postgres');
  });

  it('renders user and page values from resolved labels only, escaped, in the editor’s encoding', () => {
    const labels = { [USER]: 'Ada <script>', [PAGE]: 'Billing' };
    expect(renderTemplate('{{owner}} / {{related}}', meta, { owner: USER, related: PAGE }, { ...ctx, labels })).toBe(
      `<span data-kn-user="${USER}">@Ada &lt;script&gt;</span> / <a href="/documents/${PAGE}" data-kn-mention="1">Billing</a>`,
    );
    // An id the caller could not resolve — another tenant's, or invented — renders as nothing.
    expect(renderTemplate('[{{owner}}]', meta, { owner: USER }, ctx)).toBe('[]');
    expect(renderTemplate('[{{owner}}]', meta, { owner: '<b>x</b>' }, { ...ctx, labels })).toBe('[]');
  });

  it('formats dates in the caller’s locale, pinned to UTC', () => {
    expect(renderTemplate('{{when}}', meta, { when: '2026-01-05' }, ctx)).toBe('5 Jan 2026');
    expect(renderTemplate('{{when}}', meta, { when: '2026-01-05' }, { ...ctx, locale: 'ru' })).toMatch(/^5 янв\.? 2026/);
  });

  it('folds entity values where they are relation targets and drops a relation or tag left blank', () => {
    const data = {
      tags: ['adr', '{{number}}'],
      relations: [
        { type: 'DESCRIBES', target: '{{component}}' },
        { type: 'DEPENDS_ON', target: 'adr:{{number}}' },
      ],
    };
    expect(renderTemplateFrontmatter(data, meta, { number: '1', component: 'Service: Billing' }, ctx)).toEqual({
      tags: ['adr', '1'],
      relations: [
        { type: 'DESCRIBES', target: 'service:billing' },
        { type: 'DEPENDS_ON', target: 'adr:1' },
      ],
    });
    // `adr:` with no number is a key with no entity, so it goes too.
    expect(renderTemplateFrontmatter(data, meta, {}, ctx)).toEqual({ tags: ['adr'], relations: [] });
  });

  it('reports required placeholders left blank, and a user/page value that is not an id', () => {
    const m: TemplateMeta = { ...meta, placeholders: [...meta.placeholders, { name: 'who', kind: 'user', required: true }] };
    expect(missingRequiredPlaceholders(m, {})).toEqual(['number', 'who']);
    expect(missingRequiredPlaceholders(m, { number: ' ', who: 'Ada' })).toEqual(['number', 'who']);
    expect(missingRequiredPlaceholders(m, { number: '1', who: USER })).toEqual([]);
  });

  it('parses refs', () => {
    expect(parseTemplateRef('builtin:adr')).toEqual({ kind: 'builtin', key: 'adr' });
    expect(parseTemplateRef('builtin:nope')).toBeNull();
    expect(parseTemplateRef(USER.toUpperCase())).toEqual({ kind: 'custom', id: USER });
    expect(parseTemplateRef('adr')).toBeNull();
  });
});

describe('template sources', () => {
  it.each(BUILT_IN_TEMPLATE_KEYS.flatMap((key) => [[key, 'en'], [key, 'ru']] as const))(
    'built-in %s (%s) parses, declares every placeholder its relations use, and strips template:',
    (key, locale) => {
      const parsed = parseTemplateSource(BUILT_IN_TEMPLATES[key].text[locale].source);
      expect(parsed.data).not.toHaveProperty('template');
      expect(parsed.meta.placeholders.length).toBeGreaterThan(0);
      expect(parsed.body.startsWith('# {{title}}')).toBe(true);
      expect(parsed.tags.length).toBeGreaterThan(0);
    },
  );

  it('survives gray-matter’s parse cache: the second parse of a source still has its meta', () => {
    const source = BUILT_IN_TEMPLATES.adr.text.en.source;
    expect(parseTemplateSource(source).meta.titlePattern).toBe('ADR-{{number}}: {{title}}');
    expect(parseTemplateSource(source).meta.titlePattern).toBe('ADR-{{number}}: {{title}}');
  });

  const refuse = (source: string, code: TemplateSourceError['code']) => {
    try {
      parseTemplateSource(source);
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateSourceError);
      expect((e as TemplateSourceError).code).toBe(code);
      return;
    }
    throw new Error('expected a TemplateSourceError');
  };

  it('refuses a relation type the graph would refuse, and a target naming an undeclared placeholder', () => {
    refuse('---\nrelations:\n  - { type: TAGGED_WITH, target: "tag:x" }\n---\nx', 'invalidRelation');
    refuse('---\nrelations:\n  - { type: DESCRIBES, target: "{{nope}}" }\n---\nx', 'invalidRelation');
    // A Russian spelling of the type is authorable, as it is on a page.
    expect(
      parseTemplateSource('---\nсвязи:\n  - { type: зависит_от, target: "{{title}}" }\n---\nx').relations,
    ).toEqual([{ type: 'DEPENDS_ON', target: '{{title}}' }]);
  });

  it('refuses system, duplicate and malformed placeholder names, unknown kinds and categories', () => {
    refuse('---\ntemplate:\n  placeholders: [{ name: title }]\n---\nx', 'invalidPlaceholder');
    refuse('---\ntemplate:\n  placeholders: [{ name: a }, { name: a }]\n---\nx', 'invalidPlaceholder');
    refuse('---\ntemplate:\n  placeholders: [{ name: "1a" }]\n---\nx', 'invalidPlaceholder');
    refuse('---\ntemplate:\n  placeholders: [{ name: a, kind: html }]\n---\nx', 'invalidPlaceholder');
    refuse('---\ntemplate:\n  category: adr\n---\nx', 'invalidMeta');
    refuse('---\ntemplate: [1]\n---\nx', 'invalidMeta');
  });

  // The settings editor and "Save as template" write sources with a form, not
  // a YAML box (phase 4). What they write must be what this parser reads.
  it.each(BUILT_IN_TEMPLATE_KEYS.flatMap((key) => [[key, 'en'], [key, 'ru']] as const))(
    'composeTemplateSource round-trips built-in %s (%s) through the parser',
    (key, locale) => {
      const before = parseTemplateSource(BUILT_IN_TEMPLATES[key].text[locale].source);
      const source = composeTemplateSource({
        meta: before.meta,
        tags: before.tags,
        relations: before.relations,
        other: before.data,
        body: before.body,
      });
      const after = parseTemplateSource(source);
      expect(after.meta).toEqual(before.meta);
      expect(after.tags).toEqual(before.tags);
      expect(after.relations).toEqual(before.relations);
      expect(after.body).toBe(before.body);
    },
  );

  it('composeTemplateSource quotes what YAML would misread, keeps unmodelled keys and drops alias spellings', () => {
    const source = composeTemplateSource({
      meta: {
        category: 'guide',
        titlePattern: 'Runbook: {{service}} # {{title}}',
        placeholders: [{ name: 'service', kind: 'entity', required: true, label: 'Service: name' }],
        aiInstructions: 'Say "TODO:" where unsure.\nKeep headings.',
      },
      tags: ['runbook', 'on-call: yes'],
      relations: [{ type: 'DESCRIBES', target: 'service:{{service}}' }],
      other: { glossary: false, теги: ['dup'], template: { category: 'other' } },
      body: '\n\n# {{title}}\n',
    });
    const parsed = parseTemplateSource(source);
    expect(parsed.meta.titlePattern).toBe('Runbook: {{service}} # {{title}}');
    expect(parsed.meta.placeholders).toEqual([{ name: 'service', kind: 'entity', required: true, label: 'Service: name' }]);
    expect(parsed.meta.aiInstructions).toBe('Say "TODO:" where unsure.\nKeep headings.');
    expect(parsed.tags).toEqual(['runbook', 'on-call: yes']);
    expect(parsed.relations).toEqual([{ type: 'DESCRIBES', target: 'service:{{service}}' }]);
    expect(parsed.data).toMatchObject({ glossary: false });
    expect(parsed.data).not.toHaveProperty('теги');
    expect(parsed.body).toBe('# {{title}}\n');
  });

  it('detectPlaceholders adds what a text uses, keeps what is declared, and never declares a system name', () => {
    const detected = detectPlaceholders(
      {
        body: '# {{title}} by {{ owner }} — {{owner}}, {{due_date}}, \\{{literal}}',
        tags: ['{{team}}'],
        relations: [{ type: 'DESCRIBES', target: 'service:{{service}}' }],
      },
      [{ name: 'owner', kind: 'user', required: true }],
    );
    expect(detected).toEqual([
      { name: 'owner', kind: 'user', required: true },
      { name: 'due_date', kind: 'text' },
      { name: 'team', kind: 'text' },
      { name: 'service', kind: 'entity' },
    ]);
  });
});

// --------------------------------------------------------------------- service

interface TemplateRow {
  id: string;
  workspaceId: string;
  projectId: string | null;
  builtInKey: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  category: string;
  currentVersion: number;
  enabled: boolean;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface VersionRow {
  id: string;
  templateId: string;
  version: number;
  source: string;
  meta: unknown;
  createdBy: string | null;
  createdAt: Date;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Record<string, unknown>[]).some((w) => matches(row, w));
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      const op = want as { equals?: string; not?: unknown; in?: unknown[] };
      if ('equals' in op) return String(row[key]).toLowerCase() === String(op.equals).toLowerCase();
      if ('not' in op) return row[key] !== op.not;
      if ('in' in op) return op.in!.includes(row[key]);
    }
    return row[key] === want;
  });
}

/** A Prisma stand-in that understands the handful of shapes TemplatesService uses. */
function fakePrisma() {
  const templates: TemplateRow[] = [];
  const versions: VersionRow[] = [];
  const count = (id: string) => versions.filter((v) => v.templateId === id).length;
  const prisma = {
    templates,
    versions,
    pageTemplate: {
      findMany: async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) =>
        templates
          .filter((r) => matches(r as never, where))
          .map((r) => (include ? { ...r, _count: { versions: count(r.id) } } : { ...r })),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = templates.find((r) => matches(r as never, where));
        return row ? { ...row } : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = templates.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      },
      count: async ({ where }: { where: Record<string, unknown> }) => templates.filter((r) => matches(r as never, where)).length,
      create: async ({ data }: { data: Partial<TemplateRow> }) => {
        const row: TemplateRow = {
          id: randomUUID(),
          projectId: null,
          builtInKey: null,
          description: null,
          icon: null,
          category: 'other',
          currentVersion: 1,
          enabled: true,
          archivedAt: null,
          createdBy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          workspaceId: '',
          name: '',
          ...data,
        } as TemplateRow;
        templates.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<TemplateRow> }) => {
        const row = templates.find((r) => r.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        templates.splice(templates.findIndex((r) => r.id === where.id), 1);
        for (let i = versions.length - 1; i >= 0; i--) if (versions[i].templateId === where.id) versions.splice(i, 1);
      },
    },
    pageTemplateVersion: {
      findMany: async ({ where }: { where: { templateId: string } }) =>
        versions.filter((v) => v.templateId === where.templateId).sort((a, b) => b.version - a.version),
      findUnique: async ({ where }: { where: { templateId_version: { templateId: string; version: number } } }) =>
        versions.find(
          (v) => v.templateId === where.templateId_version.templateId && v.version === where.templateId_version.version,
        ) ?? null,
      count: async ({ where }: { where: { templateId: string } }) => count(where.templateId),
      create: async ({ data }: { data: Omit<VersionRow, 'id' | 'createdAt'> }) => {
        if (versions.some((v) => v.templateId === data.templateId && v.version === data.version)) throw new Error('P2002');
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        versions.push(row);
        return row;
      },
    },
    document: {
      findFirst: async () => ({ title: 'Parent page' }),
      findMany: async ({ where }: { where: { workspaceId: string; id: { in: string[] } } }) =>
        where.workspaceId === WS && where.id.in.includes(PAGE) ? [{ id: PAGE, title: 'Billing' }] : [],
    },
    workspaceMember: {
      findMany: async ({ where }: { where: { workspaceId: string; userId: { in: string[] } } }) =>
        where.workspaceId === WS && where.userId.in.includes(USER)
          ? [{ userId: USER, user: { displayName: 'Ada', email: 'ada@x.test' } }]
          : [],
    },
    user: { findUnique: async () => ({ displayName: 'Grace' }) },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  return prisma;
}

function makeService() {
  const prisma = fakePrisma();
  const activity = { record: vi.fn(async () => undefined) };
  const projects = {
    requireProjectInWorkspace: vi.fn(async (projectId: string, workspaceId: string) => {
      if (projectId !== PROJECT || workspaceId !== WS) throw new BadRequestException('error.project.notInWorkspace');
      return { id: PROJECT, name: 'Payments' };
    }),
  };
  const service = new TemplatesService(prisma as never, activity as never, projects as never);
  return { service, prisma, activity };
}

const CUSTOM = `---
tags: [decision]
relations:
  - type: DESCRIBES
    target: "{{component}}"
template:
  category: architecture
  placeholders:
    - { name: component, kind: entity, required: true }
---
# {{title}}

Component: {{component}}
`;

describe('TemplatesService', () => {
  it('an empty table is exactly the built-ins, in the caller’s language', async () => {
    const { service } = makeService();
    const en = await service.list({ workspaceId: WS });
    expect(en.templates.map((t) => t.ref)).toEqual(BUILT_IN_TEMPLATE_KEYS.map((k) => `builtin:${k}`));
    expect(en.templates[0]).toMatchObject({ name: 'Architecture decision record', scope: 'built-in', customized: false, id: null });
    const ru = await withLocale('ru', () => service.list({ workspaceId: WS }));
    expect(ru.templates[0].name).toBe('Архитектурное решение (ADR)');
    expect(ru.templates.find((t) => t.ref === 'builtin:postmortem')?.category).toBe('process');
  });

  it('versions a source change, not a rename, and not an identical source', async () => {
    const { service, prisma } = makeService();
    const created = await service.create({ workspaceId: WS, projectId: PROJECT, name: 'Decision', source: CUSTOM });
    expect(created).toMatchObject({ scope: 'project', currentVersion: 1, version: 1, category: 'architecture' });

    await service.update(created.id!, { name: 'Decision record', icon: '📌' });
    await service.update(created.id!, { source: CUSTOM });
    expect(prisma.versions).toHaveLength(1);

    const v2 = await service.update(created.id!, { source: CUSTOM.replace('Component:', 'Affects:') });
    expect(v2).toMatchObject({ currentVersion: 2, version: 2, name: 'Decision record', icon: '📌' });
    expect((await service.listVersions(created.id!)).versions.map((v) => v.version)).toEqual([2, 1]);
    expect((await service.get(created.id!, 1)).body).toContain('Component:');
  });

  it('refuses a duplicate name in the same scope, case-insensitively', async () => {
    const { service } = makeService();
    await service.create({ workspaceId: WS, projectId: PROJECT, name: 'Decision', source: CUSTOM });
    await expect(service.create({ workspaceId: WS, projectId: PROJECT, name: 'decision', source: CUSTOM })).rejects.toThrow(
      /nameTaken/,
    );
    await expect(service.create({ workspaceId: WS, name: 'Decision', source: CUSTOM })).resolves.toMatchObject({
      scope: 'workspace',
    });
  });

  it('refuses a bad source on save', async () => {
    const { service } = makeService();
    const bad = '---\nrelations:\n  - { type: LIKES, target: "x" }\n---\nx';
    await expect(service.create({ workspaceId: WS, name: 'Bad', source: bad })).rejects.toThrow(/source\.invalidRelation/);
  });

  it('hides a built-in with an override row, and deleting the row restores it', async () => {
    const { service } = makeService();
    const hidden = await service.create({ workspaceId: WS, builtInKey: 'rfc', enabled: false });
    const refs = (await service.list({ workspaceId: WS })).templates.map((t) => t.ref);
    expect(refs).not.toContain('builtin:rfc');
    expect((await service.list({ workspaceId: WS, includeArchived: true })).templates.map((t) => t.ref)).toContain(
      'builtin:rfc',
    );
    await service.remove(hidden.id!);
    expect((await service.list({ workspaceId: WS })).templates.map((t) => t.ref)).toContain('builtin:rfc');
  });

  it('customising a built-in continues its version line, and the ref still resolves to the override', async () => {
    const { service } = makeService();
    const source = BUILT_IN_TEMPLATES.adr.text.en.source.replace('## References', '## Links');
    const override = await service.create({ workspaceId: WS, builtInKey: 'adr', source });
    expect(override).toMatchObject({ ref: 'builtin:adr', customized: true, version: 2, name: 'Architecture decision record' });
    expect((await service.resolve(WS, 'builtin:adr')).source).toContain('## Links');
    // The shipped version is still in the history and still resolvable.
    expect((await service.resolve(WS, 'builtin:adr', 1)).source).toContain('## References');
    expect((await service.listVersions(override.id!)).versions).toMatchObject([
      { version: 2, builtIn: false },
      { version: 1, builtIn: true },
    ]);
    await expect(service.create({ workspaceId: WS, builtInKey: 'adr' })).rejects.toThrow(/alreadyCustomized/);
    await expect(service.create({ workspaceId: WS, builtInKey: 'adr', projectId: PROJECT })).rejects.toThrow(
      /builtInWorkspaceOnly/,
    );
    // Another workspace still sees the shipped one.
    expect((await service.resolve(WS_B, 'builtin:adr')).source).toContain('## References');
  });

  it('archiving hides a template from the gallery but it still resolves; rendering a new page from it is refused', async () => {
    const { service } = makeService();
    const created = await service.create({ workspaceId: WS, name: 'Decision', source: CUSTOM });
    await service.setArchived(created.id!, true);
    expect((await service.list({ workspaceId: WS })).templates.map((t) => t.id)).not.toContain(created.id);
    await expect(service.resolve(WS, created.id!)).resolves.toMatchObject({ version: 1 });
    await expect(service.render({ workspaceId: WS, ref: created.id!, values: { component: 'x' } })).rejects.toThrow(
      /archived/,
    );
    await expect(service.remove(created.id!)).rejects.toThrow(/notDeletable/);
  });

  it('never resolves a template id from another workspace', async () => {
    const { service } = makeService();
    const created = await service.create({ workspaceId: WS, name: 'Decision', source: CUSTOM });
    await expect(service.resolve(WS_B, created.id!)).rejects.toThrow(/notFound/);
    await expect(service.resolve(WS, 'builtin:adr', 9)).rejects.toThrow(/versionNotFound/);
  });

  it('renders a built-in with system, declared and resolved placeholders', async () => {
    const { service } = makeService();
    const rendered = await service.render(
      {
        workspaceId: WS,
        ref: 'builtin:adr',
        title: 'Use Postgres',
        values: { number: '0042', component: 'Service:Billing', deciders: 'Platform' },
        projectId: PROJECT,
      },
      { id: USER, name: 'Ada' },
    );
    expect(rendered).toMatchObject({
      templateRef: 'builtin:adr',
      templateVersion: 1,
      title: 'ADR-0042: Use Postgres',
      category: 'architecture',
      frontmatter: { tags: ['adr'], relations: [{ type: 'DESCRIBES', target: 'service:billing' }] },
    });
    expect(rendered.body).toContain('# Use Postgres');
    expect(rendered.body).toContain('**Author:** Ada · **Deciders:** Platform');
    expect(rendered.markdown.startsWith('---\n')).toBe(true);
    expect(rendered.markdown).not.toContain('template:');
  });

  it('a missing required value is a 400 naming it; an id outside the workspace counts as missing', async () => {
    const { service } = makeService();
    const err = await service.render({ workspaceId: WS, ref: 'builtin:adr', title: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ missing: ['number'] });

    const source = '---\ntemplate:\n  placeholders: [{ name: who, kind: user, required: true }]\n---\n{{who}}';
    const created = await service.create({ workspaceId: WS, name: 'Who', source });
    const foreign = '99999999-9999-4999-8999-999999999999';
    const err2 = await service.render({ workspaceId: WS, ref: created.id!, values: { who: foreign } }).catch((e) => e);
    expect(err2.getResponse()).toMatchObject({ missing: ['who'] });
    const ok = await service.render({ workspaceId: WS, ref: created.id!, values: { who: USER } });
    expect(ok.body).toBe(`<span data-kn-user="${USER}">@Ada</span>`);
  });
});

// ------------------------------------------------------------------ access

const editor: Principal = {
  userId: USER,
  email: 'e@x.test',
  displayName: 'Editor',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};

function accessAs(role: 'viewer' | 'editor' | 'admin', workspaceId = WS) {
  return new AccessService({
    workspaceMember: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_userId: { workspaceId: string } } }) =>
        where.workspaceId_userId.workspaceId === workspaceId ? { role, trustedOperator: false } : null,
      ),
    },
    pageTemplate: { findUnique: vi.fn(async () => ({ workspaceId: WS_B })) },
  } as never, noAuthPolicy);
}

describe('template access', () => {
  const templates = {
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    scopeOf: vi.fn(async () => ({ workspaceId: WS, projectId: null, builtInKey: null })),
  };

  it('an editor may create a project template, not a workspace-wide one or a built-in override', async () => {
    const controller = new TemplatesController(templates as never, accessAs('editor'));
    await expect(controller.create({ workspaceId: WS, projectId: PROJECT, name: 'a', source: 'x' }, editor)).resolves.toEqual({});
    await expect(controller.create({ workspaceId: WS, name: 'a', source: 'x' }, editor)).rejects.toThrow(/roleRequired/);
    await expect(
      controller.create({ workspaceId: WS, projectId: PROJECT, builtInKey: 'adr' }, editor),
    ).rejects.toThrow(/roleRequired/);
    await expect(controller.update(randomUUID(), { name: 'b' }, editor)).rejects.toThrow(/roleRequired/);

    const admin = new TemplatesController(templates as never, accessAs('admin'));
    await expect(admin.create({ workspaceId: WS, name: 'a', source: 'x' }, editor)).resolves.toEqual({});
  });

  it('resolves a :id route’s workspace from the row, so another tenant’s template is a 403', async () => {
    const reflector = {
      getAllAndOverride: () => false,
      get: () => ({ role: 'viewer', source: 'template', operator: false }),
    };
    const guard = new AclGuard(reflector as never, accessAs('admin', WS));
    const request = { principal: editor, method: 'GET', params: { id: randomUUID() }, query: { workspaceId: WS }, body: {} };
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    // The caller is admin of WS and names WS in the query; the row says WS_B.
    await expect(guard.canActivate(ctx as never)).rejects.toThrow(/notMember/);
  });
});

// --------------------------------------------------------- document creation

describe('creating a page from a template', () => {
  function documents(templates: Record<string, unknown>) {
    const stub = {} as never;
    return new DocumentsService(stub, stub, stub, stub, stub, stub, stub, stub, stub, templates as never) as unknown as {
      applyTemplate(dto: Record<string, unknown>, authorId: string): Promise<{ dto: Record<string, unknown>; template: unknown }>;
    };
  }
  const base = { workspaceId: WS, projectId: PROJECT, title: 'Use Postgres' };

  it('renders server-side when there is no content: title, body and category come from the template', async () => {
    const render = vi.fn(async () => ({
      templateRef: 'builtin:adr',
      templateVersion: 1,
      title: 'ADR-1: Use Postgres',
      category: 'architecture',
      markdown: '---\ntags: [adr]\n---\n# Use Postgres\n',
    }));
    const { dto, template } = await documents({ render }).applyTemplate(
      { ...base, template: { ref: 'builtin:adr', values: { number: '1' } } },
      USER,
    );
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, ref: 'builtin:adr', title: 'Use Postgres', values: { number: '1' } }),
      { id: USER },
    );
    expect(dto).toMatchObject({
      title: 'ADR-1: Use Postgres',
      category: 'architecture',
      content: { mode: 'inline', format: 'markdown', text: '---\ntags: [adr]\n---\n# Use Postgres\n' },
    });
    expect(template).toEqual({ ref: 'builtin:adr', version: 1 });
  });

  it('with content, the author’s text wins and the template is provenance once it resolves', async () => {
    const resolve = vi.fn(async () => ({ ref: 'builtin:adr', version: 1, parsed: { meta: { category: 'architecture' } } }));
    const render = vi.fn();
    const content = { mode: 'inline', format: 'markdown', text: '# Mine' };
    const { dto, template } = await documents({ resolve, render }).applyTemplate(
      { ...base, category: 'guide', content, template: { ref: 'builtin:adr', version: 1 } },
      USER,
    );
    expect(render).not.toHaveBeenCalled();
    expect(dto).toMatchObject({ title: 'Use Postgres', category: 'guide', content });
    expect(template).toEqual({ ref: 'builtin:adr', version: 1 });
  });

  it('provenanceOnly records the template without rendering, even with no content (the editor uploads the body)', async () => {
    const resolve = vi.fn(async () => ({ ref: 'builtin:adr', version: 2, parsed: { meta: { category: 'architecture' } } }));
    const render = vi.fn();
    const { dto, template } = await documents({ resolve, render }).applyTemplate(
      { ...base, template: { ref: 'builtin:adr', version: 2, provenanceOnly: true } },
      USER,
    );
    expect(render).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(WS, 'builtin:adr', 2);
    expect(dto).toMatchObject({ title: 'Use Postgres', category: 'architecture' });
    expect(dto).not.toHaveProperty('content');
    expect(template).toEqual({ ref: 'builtin:adr', version: 2 });
  });

  it('a page with no template is untouched', async () => {
    const { dto, template } = await documents({}).applyTemplate({ ...base }, USER);
    expect(dto).toEqual(base);
    expect(template).toBeNull();
  });
});
