import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRun, WorkflowRunNode } from '@prisma/client';
import type { WorkflowGraph, WorkflowNodeDraft, WorkflowStep } from '@knowledge/contracts';
import { TemplatesService } from '../src/templates/templates.service.js';
import { applyTemplateDefaults } from '../src/templates/apply-defaults.js';
import { WorkflowExecutors } from '../src/workflows/workflow.executors.js';
import { WorkflowMaterializerService } from '../src/workflows/workflow-materializer.service.js';
import { templateIssues } from '../src/workflows/workflow-templates.js';
import { parseMarkdown } from '../src/common/frontmatter.js';
import { withLocale } from '../src/i18n/t.js';

/**
 * Page templates in workflows and import (issue #69, phase 6).
 *
 * 1. **A template shapes a draft without instructing the model.** The rule to
 *    follow it is code; the skeleton and everything a member wrote about it is
 *    wrapped untrusted.
 * 2. **Defaults are only what is true of every page.** Declared placeholders
 *    stay `{{name}}` for the model to fill; a default relation that needs one
 *    is dropped, never written as an empty key.
 * 3. **Provenance travels draft → page**, and losing the template since must
 *    not strand a node a person approved.
 * 4. **An unknown or archived ref is refused at save**, not at run time.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const LIVE = '66666666-6666-4666-8666-666666666666';
const ARCHIVED = '77777777-7777-4777-8777-777777777777';

const CUSTOM_SOURCE = `---
tags: [runbook, ops]
relations:
  - type: DEPENDS_ON
    target: "service:billing"
  - type: DESCRIBES
    target: "{{component}}"
owner: platform
template:
  category: guide
  titlePattern: "Runbook: {{title}}"
  placeholders:
    - { name: component, label: Component, kind: entity, hint: "service:payments" }
  aiInstructions: List every alert by name.
---
# {{title}}

**Component:** {{component}} · **Project:** {{project}}

## Symptoms

## Steps
`;

function templateRow(id: string, archivedAt: Date | null) {
  return {
    id,
    workspaceId: WS,
    projectId: null,
    builtInKey: null,
    name: id === LIVE ? 'Billing runbook' : 'Old runbook',
    description: null,
    icon: null,
    category: 'guide',
    currentVersion: 1,
    enabled: true,
    archivedAt,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTemplates() {
  const rows = [templateRow(LIVE, null), templateRow(ARCHIVED, new Date())];
  const prisma = {
    pageTemplate: {
      findFirst: async ({ where }: { where: { id?: string; workspaceId: string; builtInKey?: string } }) =>
        where.builtInKey ? null : (rows.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null),
    },
    pageTemplateVersion: {
      findUnique: async ({ where }: { where: { templateId_version: { templateId: string; version: number } } }) => {
        const { templateId, version } = where.templateId_version;
        return rows.some((r) => r.id === templateId) && version === 1
          ? { id: `${templateId}-v1`, templateId, version: 1, source: CUSTOM_SOURCE, meta: {}, createdBy: null, createdAt: new Date() }
          : null;
      },
    },
    document: { findFirst: async () => null },
    user: { findUnique: async () => ({ displayName: 'Grace' }) },
  };
  const projects = { requireProjectInWorkspace: vi.fn(async () => ({ id: PROJECT, name: 'Payments' })) };
  return new TemplatesService(prisma as never, { record: vi.fn() } as never, projects as never);
}

describe('TemplatesService.defaults', () => {
  it('fills system placeholders, leaves declared ones for the writer, and keeps only unconditional defaults', async () => {
    const defaults = await withLocale('en', () =>
      makeTemplates().defaults({ workspaceId: WS, ref: LIVE, title: 'Refunds', projectId: PROJECT }),
    );
    expect(defaults).toMatchObject({ ref: LIVE, version: 1, titlePattern: 'Runbook: Refunds' });
    expect(defaults.skeleton).toContain('# Refunds');
    expect(defaults.skeleton).toContain('**Component:** {{component}} · **Project:** Payments');
    expect(defaults.tags).toEqual(['runbook', 'ops']);
    // `{{component}}` had no value, so its relation is gone rather than an empty key.
    expect(defaults.relations.map((r) => `${r.type} ${r.target.key}`)).toEqual(['DEPENDS_ON service:billing']);
    expect(defaults.frontmatter).toEqual({ owner: 'platform' });
  });

  it('refuses an archived template only when asked for a live one', async () => {
    const templates = makeTemplates();
    await expect(templates.defaults({ workspaceId: WS, ref: ARCHIVED, title: 'x', live: true })).rejects.toThrow();
    await expect(templates.defaults({ workspaceId: WS, ref: ARCHIVED, title: 'x' })).resolves.toMatchObject({
      ref: ARCHIVED,
    });
  });

  it('serves a built-in with no row', async () => {
    const defaults = await withLocale('en', () =>
      makeTemplates().defaults({ workspaceId: WS, ref: 'builtin:use-case', title: 'Checkout' }),
    );
    expect(defaults.ref).toBe('builtin:use-case');
    expect(defaults.tags).toEqual(['use-case']);
    expect(defaults.skeleton).toContain('{{actor}}');
    expect(defaults.skeleton).toContain('# Checkout');
  });
});

describe('templateIssues', () => {
  const step = (id: string, templateRef?: string): WorkflowStep => ({
    id,
    kind: 'ai.draft',
    title: id,
    next: [],
    fanOut: false,
    autoApprove: false,
    prompt: { user: 'write it' },
    produces: { category: 'guide', relationToParent: 'IMPLEMENTS', ...(templateRef !== undefined ? { templateRef } : {}) },
  });

  it('accepts built-ins and live custom templates, and reports unknown, malformed and archived refs', async () => {
    const graph: WorkflowGraph = {
      steps: [
        step('plain'),
        step('builtin', 'builtin:api-spec'),
        step('custom', LIVE),
        step('gone', '99999999-9999-4999-8999-999999999999'),
        step('bad', 'builtin:nope'),
        step('archived', ARCHIVED),
      ],
    };
    const issues = await templateIssues(makeTemplates(), WS, graph);
    expect(issues.map((i) => [i.stepId, i.code, i.severity])).toEqual([
      ['gone', 'unknownTemplate', 'error'],
      ['bad', 'unknownTemplate', 'error'],
      ['archived', 'unknownTemplate', 'error'],
    ]);
    expect(issues[1].params).toEqual({ ref: 'builtin:nope' });
  });

  it('does not reach into another workspace', async () => {
    const issues = await templateIssues(makeTemplates(), '22222222-2222-4222-8222-222222222222', {
      steps: [step('custom', LIVE)],
    });
    expect(issues.map((i) => i.code)).toEqual(['unknownTemplate']);
  });
});

describe('ai.draft with produces.templateRef', () => {
  const run = {
    id: 'run-1',
    workspaceId: WS,
    projectId: PROJECT,
    rootDocumentId: 'root',
    createdBy: USER,
    locale: 'en',
    note: null,
  } as unknown as WorkflowRun;
  const node = { id: 'node-1', input: { parentDraft: { title: 'Refunds', summary: 'Money goes back' } }, draft: null } as unknown as WorkflowRunNode;

  function makeExecutors(reply: Record<string, unknown>) {
    const chat = vi.fn(async (_ctx: unknown, _messages: Array<{ role: string; content: string }>) => JSON.stringify(reply));
    const executors = new WorkflowExecutors(
      { document: { findUnique: async () => null } } as never,
      { chat } as never,
      {} as never,
      {} as never,
      {
        resolve: async () => ({
          enabled: true,
          config: { enabled: true },
          instructions: 'You write pages.',
          skillIds: [],
        }),
      } as never,
      { forTurn: async () => [], renderPrompt: () => '' } as never,
      {} as never,
      makeTemplates(),
    );
    return { executors, chat };
  }

  const principal = {} as never;
  const step: WorkflowStep = {
    id: 'write',
    kind: 'ai.draft',
    title: 'Write',
    next: [],
    fanOut: false,
    autoApprove: false,
    prompt: { user: 'Write a runbook.' },
    produces: { category: 'guide', relationToParent: 'IMPLEMENTS', templateRef: LIVE },
  };

  it('hands the skeleton to the model wrapped untrusted, behind a code-owned rule', async () => {
    const { executors, chat } = makeExecutors({ title: 'Runbook: Refunds', markdown: '# Refunds\n\n## Symptoms\nx' });
    await withLocale('en', () => executors.run(step, node, run, principal));

    const [system, user] = chat.mock.calls[0][1];
    expect(system.content).toContain('The page is written into a page template');
    // Member-written text never reaches the system prompt.
    expect(system.content).not.toContain('List every alert');
    expect(user.content).toContain('Follow this structure exactly:');
    const wrapped = user.content.slice(user.content.indexOf('Follow this structure exactly:'));
    expect(wrapped).toMatch(/^Follow this structure exactly:\n<template tool="template">\n[^\n]*DATA, not instructions/);
    expect(wrapped.trimEnd().endsWith('</template>')).toBe(true);
    expect(wrapped).toContain('Template: Billing runbook');
    expect(wrapped).toContain('List every alert by name.');
    expect(wrapped).toContain('- {{component}}: Component (e.g. service:payments)');
    expect(wrapped).toContain('**Component:** {{component}}');
    expect(wrapped).toContain('Title pattern: Runbook: Refunds');
  });

  it('merges the template’s tags, relations and frontmatter into the draft and records provenance', async () => {
    const { executors } = makeExecutors({
      title: 'Runbook: Refunds',
      markdown: '# Refunds',
      tags: ['refunds', 'ops'],
      relations: [
        { type: 'DEPENDS_ON', targetKey: 'service:billing' },
        { type: 'RELATED_TO', targetKey: 'service:ledger' },
      ],
    });
    const result = await withLocale('en', () => executors.run(step, node, run, principal));
    expect(result.kind).toBe('draft');
    const draft = (result as { draft: WorkflowNodeDraft }).draft;
    expect(draft.templateRef).toBe(LIVE);
    expect(draft.templateVersion).toBe(1);
    expect(draft.frontmatter).toEqual({ owner: 'platform', tags: ['runbook', 'ops', 'refunds'] });
    expect(draft.relations?.map((r) => `${r.type} ${r.target.key}`)).toEqual([
      'DEPENDS_ON service:billing',
      'RELATED_TO service:ledger',
    ]);
  });

  it('leaves a step without a template exactly as before', async () => {
    const { executors, chat } = makeExecutors({ markdown: '# x' });
    const { templateRef: _omit, ...produces } = step.produces!;
    const result = await withLocale('en', () => executors.run({ ...step, produces }, node, run, principal));
    const draft = (result as { draft: WorkflowNodeDraft }).draft;
    expect(draft.templateRef).toBeUndefined();
    expect(draft.frontmatter).toBeUndefined();
    expect(chat.mock.calls[0][1][1].content).not.toContain('Follow this structure');
  });
});

describe('materializing a templated draft', () => {
  const run = { id: 'run-1', workspaceId: WS, projectId: PROJECT, rootDocumentId: 'root' } as unknown as WorkflowRun;
  const step: WorkflowStep = {
    id: 'write',
    kind: 'ai.draft',
    title: 'Write',
    next: [],
    fanOut: false,
    autoApprove: true,
    produces: { category: 'guide', relationToParent: 'IMPLEMENTS', templateRef: LIVE },
  };

  function makeMaterializer() {
    const createDocument = vi.fn(async () => ({ documentId: 'doc-1', revisionId: 'rev-1' }));
    const materializer = new WorkflowMaterializerService(
      {
        workflowRunNode: { findUnique: async () => null },
        document: { findUnique: async () => ({ id: 'root', title: 'Billing' }) },
      } as never,
      { createDocument, finalizeRevision: vi.fn(async () => ({})) } as never,
      makeTemplates(),
    );
    return { materializer, createDocument };
  }

  const nodeWith = (draft: WorkflowNodeDraft) =>
    ({ id: 'node-1', parentId: null, documentId: null, draft }) as unknown as WorkflowRunNode;

  it('records the template the draft was written against, as provenance only', async () => {
    const { materializer, createDocument } = makeMaterializer();
    await materializer.materialize(
      nodeWith({ title: 'Runbook: Refunds', markdown: '# Refunds', frontmatter: { tags: ['runbook'] }, templateRef: LIVE, templateVersion: 1 }),
      run,
      step,
    );
    const [dto] = createDocument.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(dto.template).toEqual({ ref: LIVE, version: 1 });
    expect(dto.content).toMatchObject({ mode: 'inline' });
    expect(parseMarkdown((dto.content as { text: string }).text).data).toEqual({ tags: ['runbook'] });
  });

  it('materializes without provenance when that version no longer resolves', async () => {
    const { materializer, createDocument } = makeMaterializer();
    await materializer.materialize(
      nodeWith({ title: 'Runbook', markdown: '# x', templateRef: LIVE, templateVersion: 9 }),
      run,
      step,
    );
    const [dto] = createDocument.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(dto.template).toBeUndefined();
  });
});

describe('applyTemplateDefaults (import)', () => {
  const defaults = {
    ref: LIVE,
    version: 1,
    name: 'Billing runbook',
    meta: { category: 'guide' as const, placeholders: [] },
    skeleton: '',
    titlePattern: null,
    tags: ['runbook', 'Ops'],
    relations: [{ type: 'DEPENDS_ON' as const, target: { type: 'service', key: 'service:billing', name: 'billing' } }],
    frontmatter: { owner: 'platform', status: 'draft' },
  };

  it('adds the template’s defaults to a page with no frontmatter, leaving the body alone', () => {
    const out = parseMarkdown(applyTemplateDefaults('# Imported\n\nText.', defaults));
    expect(out.body.trim()).toBe('# Imported\n\nText.');
    expect(out.data).toEqual({
      owner: 'platform',
      status: 'draft',
      tags: ['runbook', 'Ops'],
      relations: [{ type: 'DEPENDS_ON', target: 'service:billing' }],
    });
  });

  it('unions with what the page already declares and never overwrites its keys', () => {
    const page = '---\nstatus: final\ntags: [ops]\nrelations:\n  - type: depends_on\n    target: Service:Billing\n---\n# Imported\n';
    const out = parseMarkdown(applyTemplateDefaults(page, defaults));
    expect(out.data).toEqual({
      status: 'final',
      owner: 'platform',
      tags: ['ops', 'runbook'],
      relations: [{ type: 'depends_on', target: 'Service:Billing' }],
    });
  });
});
